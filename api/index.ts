/**
 * Vercel serverless entry — re-exports the Express app.
 * All routes are rewritten here via vercel.json.
 */
import app from "../src/index.js";

export default app;
