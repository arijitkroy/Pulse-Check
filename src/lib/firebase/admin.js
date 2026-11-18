import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
function app() {
  if (getApps().length) return getApps()[0];
  const projectId =
    process.env.FIREBASE_PROJECT_ID ||
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!projectId || !process.env.FIREBASE_CLIENT_EMAIL || !privateKey)
    throw new Error("Firebase Admin environment is incomplete");
  return initializeApp({
    credential: cert({
      projectId,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey,
    }),
    projectId,
  });
}
export const adminAuth = () => getAuth(app());
export const db = () => getFirestore(app());
export const adminApp = () => app();
