// Cloudflare Worker entry point. The catalog is bundled from ../../catalog.json so prices can't be tampered with.
import catalog from "../../catalog.json";
import supplier from "../supplier.json";
import { createHandler } from "./app.js";

const handle = createHandler({ catalog, supplier });
export default { fetch: (req, env) => handle(req, env) };
