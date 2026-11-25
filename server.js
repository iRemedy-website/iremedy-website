require("dotenv").config({ path: __dirname + "/.env" });

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const { Pool } = require("pg");
const path = require("path");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const bcrypt = require("bcryptjs");

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET is missing from .env");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});

console.log("DATABASE_URL loaded:", !!process.env.DATABASE_URL);
// Paystack Webhook
app.post(
  "/api/paystack/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const signature = req.headers["x-paystack-signature"];

      if (!signature || !Buffer.isBuffer(req.body)) {
        return res.sendStatus(401);
      }

      const expectedSignature = crypto
        .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
        .update(req.body)
        .digest("hex");

      const received = Buffer.from(signature, "hex");
      const expected = Buffer.from(expectedSignature, "hex");

      if (
        received.length !== expected.length ||
        !crypto.timingSafeEqual(received, expected)
      ) {
        return res.sendStatus(401);
      }

      const event = JSON.parse(req.body.toString("utf8"));

      if (event.event !== "charge.success") {
        return res.sendStatus(200);
      }

      const reference = event.data?.reference;

      if (!reference) {
        return res.sendStatus(400);
      }

      // Reuse the existing Paystack verification route
      await axios.get(
        `https://iremedy-website.onrender.com/api/payments/paystack/verify/${encodeURIComponent(reference)}`
      );

      return res.sendStatus(200);

    } catch (error) {
      console.error("Paystack webhook error:", error.message);
      return res.sendStatus(500);
    }
  }
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session security
app.set("trust proxy", 1);

app.use(session({
  store: new PgSession({
    pool: pool,
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 8
  }
}));

// Admin protection
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) {
    return next();
  }

  return res.status(401).json({
    success: false,
    message: "Please log in as admin"
  });
}

// Admin login
app.post("/api/admin/login", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({
      success: false,
      message: "Enter your username and password"
    });
  }
console.log(
  "Admin username matches:",
  username === process.env.ADMIN_USERNAME
);
console.log(
  "Admin password hash exists:",
  Boolean(process.env.ADMIN_PASSWORD_HASH)
);
  if (username !== process.env.ADMIN_USERNAME) {
    return res.status(401).json({
      success: false,
      message: "Invalid username or password"
    });
  }

  try {
    const validPassword = await bcrypt.compare(
      password,
      process.env.ADMIN_PASSWORD_HASH
    );
console.log("Admin password matches:", validPassword);
    if (!validPassword) {
      return res.status(401).json({
        success: false,
        message: "Invalid username or password"
      });
    }

    req.session.regenerate((error) => {
      if (error) {
        return res.status(500).json({
          success: false,
          message: "Unable to start admin session"
        });
      }

      req.session.isAdmin = true;

      req.session.save((error) => {
        if (error) {
          return res.status(500).json({
            success: false,
            message: "Unable to save admin session"
          });
        }

        res.json({
          success: true,
          message: "Admin login successful"
        });
      });
    });

  } catch (error) {
    console.error("Admin login failed:", error.message);

    res.status(500).json({
      success: false,
      message: "Unable to process admin login"
    });
  }
});

// Admin logout
app.post("/api/admin/logout", (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      return res.status(500).json({
        success: false,
        message: "Unable to log out"
      });
    }

    res.clearCookie("connect.sid");

    res.json({
      success: true,
      message: "Logged out successfully"
    });
  });
});

// Static website files
app.use(express.static(path.join(__dirname, "public")));

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    business: "iRemedy Phones & Accessories",
    status: "Website server is running"
  });
});

// Database check
app.get("/api/db-check", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");

    res.json({
      success: true,
      database: "Connected",
      time: result.rows[0].now
    });

  } catch (error) {
    console.error("Database connection failed:", error.message);

    res.status(500).json({
      success: false,
      database: "Not connected"
    });
  }
});

// Get all products
app.get("/api/products", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM products ORDER BY id ASC"
    );

    res.json({
      success: true,
      products: result.rows
    });

  } catch (error) {
    console.error("Products fetch failed:", error.message);

    res.status(500).json({
      success: false,
      message: "Unable to load products"
    });
  }
});

// Save customer orders
app.post("/api/orders", async (req, res) => {
  const {
    customerName,
    customerPhone,
    deliveryAddress,
    items
  } = req.body;

  if (
    !customerName ||
    !customerPhone ||
    !deliveryAddress ||
    !Array.isArray(items) ||
    items.length === 0
  ) {
    return res.status(400).json({
      success: false,
      message: "Please provide all customer and order details"
    });
  }

  let client;
  let transactionStarted = false;

  try {
    client = await pool.connect();

    await client.query("BEGIN");
    transactionStarted = true;

    let total = 0;
    const orderItems = [];

    for (const item of items) {
      const productId = Number(item.productId);
      const quantity = Number(item.quantity);

      if (
        !Number.isInteger(productId) ||
        productId <= 0 ||
        !Number.isInteger(quantity) ||
        quantity <= 0 ||
        quantity > 100
      ) {
        throw new Error("Invalid product or quantity");
      }

      const result = await client.query(
        `SELECT id, name, storage, price, stock_quantity
         FROM products
         WHERE id = $1
         FOR UPDATE`,
        [productId]
      );

      if (result.rows.length === 0) {
        throw new Error("A selected product was not found");
      }

      const product = result.rows[0];
      const availableStock = Number(product.stock_quantity ?? 0);

      if (availableStock < quantity) {
        throw new Error(
          `Not enough stock for ${product.name} ${product.storage}. Available: ${availableStock}`
        );
      }

      const price = Number(product.price);

      if (!Number.isFinite(price) || price <= 0) {
        throw new Error("Invalid product price");
      }

      await client.query(
        `UPDATE products
         SET stock_quantity = stock_quantity - $1
         WHERE id = $2`,
        [quantity, productId]
      );

      total += price * quantity;

      orderItems.push({
        productId: product.id,
        name: product.name,
        storage: product.storage,
        price,
        quantity
      });
    }

    const orderResult = await client.query(
      `INSERT INTO orders
       (customer_name, customer_phone, delivery_address, total)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [customerName, customerPhone, deliveryAddress, total]
    );

    const orderId = orderResult.rows[0].id;

    for (const item of orderItems) {
      await client.query(
        `INSERT INTO order_items
         (order_id, product_id, product_name, storage, unit_price, quantity)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          orderId,
          item.productId,
          item.name,
          item.storage,
          item.price,
          item.quantity
        ]
      );
    }

    await client.query("COMMIT");
    transactionStarted = false;

    res.status(201).json({
      success: true,
      message: "Order saved successfully",
      orderId,
      total
    });

  } catch (error) {
    if (client && transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Order rollback failed:", rollbackError.message);
      }
    }

    console.error("Order saving failed:", error.message);

    res.status(400).json({
      success: false,
      message: error.message
    });

  } finally {
    if (client) {
      client.release();
    }
  }
});
// Admin: View all customer orders (login required)
app.get("/api/admin/orders", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        o.id,
        o.customer_name,
        o.customer_phone,
        o.delivery_address,
        o.total,
o.status,
o.payment_status,
o.payment_method,
o.created_at,
        COALESCE(
          json_agg(
            json_build_object(
              'product_name', oi.product_name,
              'storage', oi.storage,
              'unit_price', oi.unit_price,
              'quantity', oi.quantity
            )
          ) FILTER (WHERE oi.id IS NOT NULL),
          '[]'
        ) AS items
      FROM orders o
      LEFT JOIN order_items oi ON o.id = oi.order_id
      GROUP BY o.id
      ORDER BY o.created_at DESC
    `);

    res.json({
      success: true,
      orders: result.rows
    });

  } catch (error) {
    console.error("Admin orders fetch failed:", error.message);

    res.status(500).json({
      success: false,
      message: "Unable to load orders"
    });
  }
});

// Admin: Update order status (login required)
app.patch("/api/admin/orders/:id/status", requireAdmin, async (req, res) => {
  const { status } = req.body;
  const orderId = Number(req.params.id);

  const allowedStatuses = ["Pending", "Confirmed", "Delivered"];

  if (
    !Number.isInteger(orderId) ||
    orderId <= 0 ||
    !allowedStatuses.includes(status)
  ) {
    return res.status(400).json({
      success: false,
      message: "Invalid order ID or status"
    });
  }

  try {
    const result = await pool.query(
      `UPDATE orders
       SET status = $1
       WHERE id = $2
       RETURNING id, status`,
      [status, orderId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Order not found"
      });
    }

    res.json({
      success: true,
      message: "Order status updated",
      order: result.rows[0]
    });

  } catch (error) {
    console.error("Order status update failed:", error.message);

    res.status(500).json({
      success: false,
      message: "Unable to update order status"
    });
  }
});
// ADMIN: Add a new product
app.post("/api/admin/products", requireAdmin, async (req, res) => {
  const { name, storage, price, condition } = req.body;

  const productName = String(name || "").trim();
  const productStorage = String(storage || "").trim();
  const productPrice = Number(price);
  const productCondition = String(condition || "UK Used").trim();

  if (
    !productName ||
    !productStorage ||
    !Number.isFinite(productPrice) ||
    productPrice <= 0 ||
    !productCondition
  ) {
    return res.status(400).json({
      success: false,
      message: "Enter a valid product name, storage and price"
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO products (name, storage, price, condition, currency)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [productName, productStorage, productPrice, productCondition, "GH₵"]
    );

    res.status(201).json({
      success: true,
      message: "Product added successfully",
      product: result.rows[0]
    });

  } catch (error) {
    console.error("Product creation failed:", error.message);
    res.status(500).json({
      success: false,
      message: "Unable to add product"
    });
  }
});

// ADMIN: Edit an existing product
app.put("/api/admin/products/:id", requireAdmin, async (req, res) => {
  const productId = Number(req.params.id);
  const { name, storage, price, condition } = req.body;

  const productName = String(name || "").trim();
  const productStorage = String(storage || "").trim();
  const productPrice = Number(price);
  const stockQuantity = Number(req.body.stock_quantity ?? 0);
  const productCondition = String(condition || "UK Used").trim();

  if (
    !Number.isInteger(productId) ||
    productId <= 0 ||
    !productName ||
    !productStorage ||
    !Number.isFinite(productPrice) ||
    productPrice <= 0 ||
    !Number.isInteger(stockQuantity) ||
stockQuantity < 0 ||
!productCondition
  ) {
    return res.status(400).json({
      success: false,
      message: "Enter valid product details"
    });
  }

  try {
    const result = await pool.query(
      `UPDATE products
       SET name = $1, storage = $2, price = $3, condition = $4, stock_quantity = $5
WHERE id = $6
       RETURNING *`,
      [productName, productStorage, productPrice, productCondition, stockQuantity, productId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Product not found"
      });
    }

    res.json({
      success: true,
      message: "Product updated successfully",
      product: result.rows[0]
    });

  } catch (error) {
    console.error("Product update failed:", error.message);
    res.status(500).json({
      success: false,
      message: "Unable to update product"
    });
  }
});

// ADMIN: Delete a product
app.delete("/api/admin/products/:id", requireAdmin, async (req, res) => {
  const productId = Number(req.params.id);

  if (!Number.isInteger(productId) || productId <= 0) {
    return res.status(400).json({
      success: false,
      message: "Invalid product ID"
    });
  }

  try {
    const result = await pool.query(
      "DELETE FROM products WHERE id = $1 RETURNING id",
      [productId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Product not found"
      });
    }

    res.json({
      success: true,
      message: "Product deleted successfully"
    });

  } catch (error) {
    console.error("Product deletion failed:", error.message);
    res.status(500).json({
      success: false,
      message: "Unable to delete product. It may be linked to an existing order."
    });
  }
});
// ADMIN: Sales reports (login required)
app.get("/api/admin/reports", requireAdmin, async (req, res) => {
  try {
    const summary = await pool.query(`
      SELECT
        COUNT(*)::INTEGER AS total_orders,
        COUNT(*) FILTER (WHERE status = 'Pending')::INTEGER AS pending_orders,
        COUNT(*) FILTER (WHERE status = 'Confirmed')::INTEGER AS confirmed_orders,
        COUNT(*) FILTER (WHERE status = 'Delivered')::INTEGER AS delivered_orders,
        COALESCE(
          SUM(total) FILTER (WHERE status = 'Delivered'), 0
        ) AS delivered_revenue,
        COALESCE(
          SUM(total) FILTER (WHERE status = 'Confirmed'), 0
        ) AS confirmed_value,
        COALESCE(
          SUM(total) FILTER (
            WHERE status = 'Delivered'
            AND created_at >= CURRENT_DATE
          ), 0
        ) AS today_revenue,
        COALESCE(
          SUM(total) FILTER (
            WHERE status = 'Delivered'
            AND created_at >= DATE_TRUNC('month', CURRENT_DATE)
          ), 0
        ) AS monthly_revenue
      FROM orders
    `);

    const bestSellers = await pool.query(`
      SELECT
        product_name,
        storage,
        SUM(quantity)::INTEGER AS units_sold
      FROM order_items oi
      INNER JOIN orders o ON o.id = oi.order_id
      WHERE o.status = 'Delivered'
      GROUP BY product_name, storage
      ORDER BY units_sold DESC
      LIMIT 5
    `);

    res.json({
      success: true,
      summary: summary.rows[0],
      bestSellers: bestSellers.rows
    });

  } catch (error) {
    console.error("Sales report failed:", error.message);

    res.status(500).json({
      success: false,
      message: "Unable to load sales reports"
    });
  }
});
// Initialize Paystack Payment
app.post("/api/payments/paystack/initialize", async (req, res) => {
  try {
    const {
      customerName,
      customerPhone,
      deliveryAddress,
      email,
      items
    } = req.body;

    if (
      !customerName ||
      !customerPhone ||
      !deliveryAddress ||
      !email ||
      !Array.isArray(items) ||
      items.length === 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Please complete all customer details and add products."
      });
    }

    let total = 0;
    const verifiedItems = [];

    for (const item of items) {
      const productId = Number(item.productId);
      const quantity = Number(item.quantity);

      if (
        !Number.isInteger(productId) ||
        productId <= 0 ||
        !Number.isInteger(quantity) ||
        quantity <= 0
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid product or quantity."
        });
      }

      const result = await pool.query(
        `SELECT id, name, storage, price, stock_quantity
         FROM products
         WHERE id = $1`,
        [productId]
      );

      if (result.rows.length === 0) {
        return res.status(400).json({
          success: false,
          message: "A product in your cart could not be found."
        });
      }

      const product = result.rows[0];

      if (Number(product.stock_quantity) < quantity) {
        return res.status(400).json({
          success: false,
          message: product.name + " is out of stock or has insufficient stock."
        });
      }

      const unitPrice = Number(product.price);
      total += unitPrice * quantity;

      verifiedItems.push({
        productId: product.id,
        name: product.name,
        storage: product.storage,
        unitPrice,
        quantity
      });
    }

    const reference = crypto.randomUUID();

    const payment = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email,
        amount: Math.round(total * 100),
        currency: "GHS",
        reference,
        callback_url: process.env.PAYSTACK_CALLBACK_URL,
        metadata: {
          customerName,
          customerPhone,
          deliveryAddress,
          items: verifiedItems
        }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    return res.json({
      success: true,
      authorization_url: payment.data.data.authorization_url,
      reference
    });

  } catch (error) {
    console.error(
      "Paystack initialization error:",
      error.response?.data || error.message
    );

    return res.status(500).json({
      success: false,
      message: "Unable to start payment. Please try again."
    });
  }
});
// Verify Paystack Payment
app.get("/api/payments/paystack/verify/:reference", async (req, res) => {
  const reference = req.params.reference;
  const client = await pool.connect();

  try {
    if (!reference) {
      return res.status(400).json({
        success: false,
        message: "Payment reference is missing."
      });
    }

    // Check whether this payment has already created an order
    const existingOrder = await pool.query(
      `SELECT id, total
       FROM orders
       WHERE payment_reference = $1`,
      [reference]
    );

    if (existingOrder.rows.length > 0) {
      return res.json({
        success: true,
        message: "Payment was already verified.",
        orderId: existingOrder.rows[0].id
      });
    }

    // Verify payment directly with Paystack
    const verification = await axios.get(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
        }
      }
    );

    const payment = verification.data.data;

    if (
      payment.status !== "success" ||
      payment.reference !== reference ||
      payment.currency !== "GHS"
    ) {
      return res.status(400).json({
        success: false,
        message: "Payment has not been confirmed."
      });
    }

    const metadata = payment.metadata || {};
    const items = metadata.items;

    if (
      !metadata.customerName ||
      !metadata.customerPhone ||
      !metadata.deliveryAddress ||
      !Array.isArray(items) ||
      items.length === 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Payment details are incomplete. Please contact the shop."
      });
    }

    const expectedTotal = items.reduce(
      (sum, item) =>
        sum + Number(item.unitPrice) * Number(item.quantity),
      0
    );

    if (
      !Number.isFinite(expectedTotal) ||
      expectedTotal <= 0 ||
      payment.amount !== Math.round(expectedTotal * 100)
    ) {
      return res.status(400).json({
        success: false,
        message: "Payment amount does not match the order."
      });
    }

    await client.query("BEGIN");

    // Lock products and confirm stock before creating the order
    for (const item of items) {
      const productId = Number(item.productId);
      const quantity = Number(item.quantity);

      if (
        !Number.isInteger(productId) ||
        !Number.isInteger(quantity) ||
        productId <= 0 ||
        quantity <= 0
      ) {
        throw new Error("Invalid product details in payment.");
      }

      const productResult = await client.query(
        `SELECT id, name, storage, price, stock_quantity
         FROM products
         WHERE id = $1
         FOR UPDATE`,
        [productId]
      );

      if (
        productResult.rows.length === 0 ||
        Number(productResult.rows[0].stock_quantity) < quantity ||
        Number(productResult.rows[0].price) !== Number(item.unitPrice)
      ) {
        throw new Error(
          "Payment succeeded, but stock or product details changed. Contact the shop before placing another order."
        );
      }

      item.name = productResult.rows[0].name;
      item.storage = productResult.rows[0].storage;
    }

    const orderResult = await client.query(
      `INSERT INTO orders (
        customer_name,
        customer_phone,
        delivery_address,
        total,
        status,
        payment_reference,
        payment_status,
        payment_method
      )
      VALUES ($1, $2, $3, $4, 'Pending', $5, 'paid', 'Paystack')
      RETURNING id`,
      [
        metadata.customerName,
        metadata.customerPhone,
        metadata.deliveryAddress,
        expectedTotal,
        reference
      ]
    );

    const orderId = orderResult.rows[0].id;

    for (const item of items) {
      await client.query(
        `UPDATE products
         SET stock_quantity = stock_quantity - $1
         WHERE id = $2`,
        [Number(item.quantity), Number(item.productId)]
      );

      await client.query(
        `INSERT INTO order_items (
          order_id,
          product_id,
          product_name,
          storage,
          unit_price,
          quantity
        )
        VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          orderId,
          Number(item.productId),
          item.name,
          item.storage,
          Number(item.unitPrice),
          Number(item.quantity)
        ]
      );
    }

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "Payment verified and order saved successfully.",
      orderId
    });

  } catch (error) {
    await client.query("ROLLBACK");

    console.error("Paystack verification error:", error.message);

    return res.status(500).json({
      success: false,
      message: error.message
    });

  } finally {
    client.release();
  }
});
// Homepage
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Create database tables and start server
async function startServer() {
  try {
       await pool.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        storage VARCHAR(50) NOT NULL,
        price NUMERIC(12, 2) NOT NULL,
        stock_quantity INTEGER DEFAULT 0,
        condition VARCHAR(50) DEFAULT 'UK Used',
        currency VARCHAR(10) DEFAULT 'GH₵',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
  ALTER TABLE products
  ADD COLUMN IF NOT EXISTS stock_quantity INTEGER DEFAULT 0
`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        customer_name VARCHAR(150) NOT NULL,
        customer_phone VARCHAR(30) NOT NULL,
        delivery_address TEXT NOT NULL,
        total NUMERIC(12, 2) NOT NULL,
        status VARCHAR(30) DEFAULT 'Pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
await pool.query(`
      ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS payment_reference VARCHAR(100),
      ADD COLUMN IF NOT EXISTS payment_status VARCHAR(30) DEFAULT 'unpaid',
      ADD COLUMN IF NOT EXISTS payment_method VARCHAR(30)
    `);

    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
      orders_payment_reference_unique
      ON orders(payment_reference)
      WHERE payment_reference IS NOT NULL
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id SERIAL PRIMARY KEY,
        order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
        product_id INTEGER REFERENCES products(id),
        product_name VARCHAR(100) NOT NULL,
        storage VARCHAR(50) NOT NULL,
        unit_price NUMERIC(12, 2) NOT NULL,
        quantity INTEGER DEFAULT 1
      )
    `);

    console.log("Products table ready");
    console.log("Orders table ready");
    console.log("Order items table ready");

    app.listen(PORT, () => {
      console.log(`iRemedy server running on port ${PORT}`);
    });

  } catch (error) {
    console.error("Database setup failed:", error.message);
    process.exit(1);
  }
}

startServer();