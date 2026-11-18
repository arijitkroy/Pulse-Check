import { initializeApp, getApps } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
};
export const firebaseApp = getApps().length
  ? getApps()[0]
  : initializeApp(config);
// Avoid initializing browser-only Auth APIs during Next.js server rendering.
export const auth = typeof window === "undefined" ? null : getAuth(firebaseApp);
export const clientDb =
  typeof window === "undefined" ? null : getFirestore(firebaseApp);
