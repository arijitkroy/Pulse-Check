import app from "../server/app.js";

export default function handler(req, res) {
  const requestedPath = req.query?.__path;
  if (typeof requestedPath === "string" && requestedPath.startsWith("/")) {
    const query = new URLSearchParams(req.query);
    query.delete("__path");
    const queryString = query.toString();
    req.url = `${requestedPath}${queryString ? `?${queryString}` : ""}`;
  }

  return app(req, res);
}
