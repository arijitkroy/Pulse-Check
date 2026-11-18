import { adminAuth } from "../firebase/admin.js";
export async function getUser(req) {
  if (req.cookies?.__session) {
    try {
      return await adminAuth().verifySessionCookie(req.cookies.__session, true);
    } catch (_) {}
  }
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ")
    ? adminAuth().verifyIdToken(h.slice(7), true)
    : null;
}
