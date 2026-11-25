require("dotenv").config({ path: __dirname + "/.env" });

const { Pool } = require("pg");

const products = [
  { name: "iPhone 6s", storage: "16GB", price: 670 },
  { name: "iPhone 7", storage: "32GB", price: 850 },
  { name: "iPhone X", storage: "64GB", price: 1750 },
  { name: "iPhone X", storage: "256GB", price: 1900 },
  { name: "iPhone XR", storage: "64GB", price: 1900 },
  { name: "iPhone XR", storage: "128GB", price: 2100 },
  { name: "iPhone 11", storage: "64GB", price: 2200 },
  { name: "iPhone 11", storage: "128GB", price: 2500 },
  { name: "iPhone 11", storage: "256GB", price: 2700 },
  { name: "iPhone 11 Pro", storage: "64GB", price: 2800 },
  { name: "iPhone 11 Pro", storage: "128GB", price: 2950 },
  { name: "iPhone 11 Pro", storage: "256GB", price: 3200 },
  { name: "iPhone 11 Pro Max", storage: "64GB", price: 2700 },
  { name: "iPhone 11 Pro Max", storage: "256GB", price: 3200 },
  { name: "iPhone 12", storage: "64GB", price: 2600 },
  { name: "iPhone 12", storage: "128GB", price: 3000 },
  { name: "iPhone 12", storage: "256GB", price: 3200 },
  { name: "iPhone 12 Pro", storage: "128GB", price: 3600 },
  { name: "iPhone 12 Pro", storage: "256GB", price: 3750 },
  { name: "iPhone 12 Pro", storage: "512GB", price: 3900 },
  { name: "iPhone 12 Pro Max", storage: "128GB", price: 4100 },
  { name: "iPhone 12 Pro Max", storage: "256GB", price: 4500 },
  { name: "iPhone 12 Pro Max", storage: "512GB", price: 4700 },
  { name: "iPhone 13", storage: "128GB", price: 3600 },
  { name: "iPhone 13", storage: "256GB", price: 3850 },
  { name: "iPhone 13 Pro", storage: "128GB", price: 4400 },
  { name: "iPhone 13 Pro", storage: "256GB", price: 4700 },
  { name: "iPhone 13 Pro", storage: "512GB", price: 4900 },
  { name: "iPhone 13 Pro Max", storage: "128GB", price: 5500 },
  { name: "iPhone 13 Pro Max", storage: "256GB", price: 5900 },
  { name: "iPhone 13 Pro Max", storage: "512GB", price: 6100 },
  { name: "iPhone 14", storage: "128GB", price: 4300 },
  { name: "iPhone 14", storage: "256GB", price: 4600 },
  { name: "iPhone 14 Pro", storage: "128GB", price: 5700 },
  { name: "iPhone 14 Pro", storage: "128GB eSIM", price: 5400 },
  { name: "iPhone 14 Pro", storage: "256GB", price: 6000 }
];

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});

async function seedProducts() {
  try {
    let added = 0;

    for (const product of products) {
      const result = await pool.query(
        `INSERT INTO products
  (name, storage, price, condition, currency)
 SELECT $1::varchar, $2::varchar, $3::numeric, $4::varchar, $5::varchar
 WHERE NOT EXISTS (
   SELECT 1 FROM products
   WHERE name = $1::varchar AND storage = $2::varchar
 )`,
        [
          product.name,
          product.storage,
          product.price,
          "UK Used",
          "GH₵"
        ]
      );

      added += result.rowCount;
    }

    console.log("Catalogue import completed!");
    console.log("Products in catalogue:", products.length);
    console.log("New products added:", added);

  } catch (error) {
    console.error("Product import failed:", error.message);
  } finally {
    await pool.end();
  }
}

seedProducts();