/* ============================================================
   BLL — Firebase Backend (production)
   ------------------------------------------------------------
   Every page on the site loads this ONE file as a module.
   It exposes everything through window.BLL so plain inline
   <script> tags on any page (they are not modules themselves)
   can call window.BLL.whatever(...) without knowing anything
   about how Firebase actually works underneath.

   SECURITY NOTE (read this before you launch for real):
   This is a static site with no server, so "admin protection"
   here works by checking a password stored in a Firestore
   document from the browser. That is convenient, but it is
   NOT the same as real server-side auth — anyone who reads this
   file can see how the check works. Before you rely on this for
   anything sensitive, lock down Firestore Security Rules so the
   `admin_config`, `comments` (write/delete), and `decoy_visits`
   collections can only be touched the way you intend. This file
   gets you a fully working v1; rules are the next hardening step.
   ============================================================ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getAnalytics, isSupported as analyticsSupported } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-analytics.js";
import {
  getFirestore,
  collection,
  addDoc,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  getDocs,
  onSnapshot,
  query,
  where,
  orderBy,
  increment,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updateProfile
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";

// -----------------------------------------------------------
// Firebase project config
// -----------------------------------------------------------
const firebaseConfig = {
  apiKey: "AIzaSyCD8vQv1YCwcZ_CJWunnKwsToOOLXeajIc",
  authDomain: "my-business-receipts.firebaseapp.com",
  projectId: "my-business-receipts",
  storageBucket: "my-business-receipts.firebasestorage.app",
  messagingSenderId: "131689566222",
  appId: "1:131689566222:web:b59aaeec10807eb441ec5f",
  measurementId: "G-T52TE3JCGC"
};

let app, db, auth;
try {
  app = initializeApp(firebaseConfig);
  db = getFirestore(app);
  auth = getAuth(app);
  analyticsSupported().then((ok) => { if (ok) getAnalytics(app); }).catch(() => {});
} catch (err) {
  console.warn("[BLL] Firebase failed to initialize — running in offline demo mode.", err);
}

/* ============================================================
   HELPERS
   ============================================================ */

async function getVisitorIP() {
  try {
    const res = await fetch("https://api.ipify.org?format=json");
    const data = await res.json();
    return data.ip || "unknown";
  } catch {
    return "unknown";
  }
}

/* ============================================================
   VISITOR LOGGING
   ============================================================ */

async function logVisit() {
  if (!db) return;
  try {
    const ip = await getVisitorIP();
    await addDoc(collection(db, "visitors"), {
      page: window.location.pathname,
      referrer: document.referrer || "direct",
      ip,
      userAgent: navigator.userAgent,
      timestamp: serverTimestamp()
    });
  } catch (err) {
    console.warn("[BLL] Could not log visit:", err);
  }
}

// Used only by admin.html — the decoy page. Anyone who lands there
// gets logged into a separate collection so it never mixes with
// normal traffic, and Saga can review attempts privately.
async function logDecoyVisit() {
  if (!db) return;
  try {
    const ip = await getVisitorIP();
    await addDoc(collection(db, "decoy_visits"), {
      ip,
      userAgent: navigator.userAgent,
      referrer: document.referrer || "direct",
      timestamp: serverTimestamp()
    });
  } catch (err) {
    console.warn("[BLL] Could not log decoy visit:", err);
  }
}

/* ============================================================
   EMAIL SUBSCRIPTION
   ============================================================ */

async function subscribeEmail(email) {
  const cleaned = (email || "").toLowerCase().trim();
  if (!cleaned || !cleaned.includes("@")) {
    return { ok: false, message: "That doesn't look like a valid email — mind checking it?" };
  }
  if (!db) return { ok: false, message: "Subscriptions aren't connected yet — check back soon." };

  try {
    await setDoc(doc(db, "subscribers", cleaned), {
      email: cleaned,
      subscribedAt: serverTimestamp(),
      source: window.location.pathname
    });
    return { ok: true, message: "You're in! Watch your inbox for new chapters and drops." };
  } catch (err) {
    console.warn("[BLL] Could not save subscriber:", err);
    return { ok: false, message: "Something went wrong on our end. Please try again in a moment." };
  }
}

/* ============================================================
   COMMENTS (name + email required, only name is ever shown)
   No account needed — used on blog posts and course chapters.
   ============================================================ */

async function addComment(pageId, name, email, text) {
  if (!db) return { ok: false, message: "Comments aren't connected yet." };
  const cleanName = (name || "").trim();
  const cleanEmail = (email || "").trim().toLowerCase();
  const cleanText = (text || "").trim();

  if (!cleanName || !cleanEmail || !cleanText) {
    return { ok: false, message: "Name, email, and a comment are all required." };
  }
  if (!cleanEmail.includes("@")) {
    return { ok: false, message: "That email doesn't look right." };
  }

  try {
    await addDoc(collection(db, "comments"), {
      pageId,
      name: cleanName,
      email: cleanEmail,       // stored for moderation only — never rendered publicly
      text: cleanText,
      timestamp: serverTimestamp()
    });
    return { ok: true, message: "Comment posted." };
  } catch (err) {
    console.warn("[BLL] Could not post comment:", err);
    return { ok: false, message: "Something went wrong posting that. Try again." };
  }
}

// Live-updating comment feed for a given page.
// Returns an "unsubscribe" function — call it when leaving the page.
function watchComments(pageId, callback) {
  if (!db) return () => {};
  const q = query(collection(db, "comments"), where("pageId", "==", pageId), orderBy("timestamp", "desc"));
  return onSnapshot(q, (snap) => {
    const list = [];
    snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
    callback(list);
  });
}

/* ============================================================
   LIKES (soft-protected with localStorage, one like per browser)
   ============================================================ */

async function toggleLike(pageId) {
  if (!db) return { ok: false, liked: false, count: 0 };

  const storageKey = `bll_liked_${pageId}`;
  const alreadyLiked = localStorage.getItem(storageKey) === "true";
  const ref = doc(db, "post_likes", pageId);

  try {
    const snap = await getDoc(ref);
    const currentCount = snap.exists() ? (snap.data().count || 0) : 0;

    if (alreadyLiked) {
      await setDoc(ref, { count: Math.max(0, currentCount - 1) }, { merge: true });
      localStorage.removeItem(storageKey);
      return { ok: true, liked: false, count: Math.max(0, currentCount - 1) };
    } else {
      await setDoc(ref, { count: currentCount + 1 }, { merge: true });
      localStorage.setItem(storageKey, "true");
      return { ok: true, liked: true, count: currentCount + 1 };
    }
  } catch (err) {
    console.warn("[BLL] Could not toggle like:", err);
    return { ok: false, liked: alreadyLiked, count: 0 };
  }
}

async function getLikeState(pageId) {
  const liked = localStorage.getItem(`bll_liked_${pageId}`) === "true";
  if (!db) return { liked, count: 0 };
  try {
    const snap = await getDoc(doc(db, "post_likes", pageId));
    return { liked, count: snap.exists() ? (snap.data().count || 0) : 0 };
  } catch {
    return { liked, count: 0 };
  }
}

/* ============================================================
   USER ACCOUNTS (optional — never required to read/study)
   ============================================================ */

async function signUp(name, email, password) {
  if (!auth) return { ok: false, message: "Accounts aren't connected yet." };
  try {
    const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
    await updateProfile(cred.user, { displayName: name.trim() });
    await setDoc(doc(db, "users", cred.user.uid), {
      name: name.trim(),
      email: email.trim().toLowerCase(),
      joinedAt: serverTimestamp()
    });
    return { ok: true, message: "Account created!" };
  } catch (err) {
    return { ok: false, message: friendlyAuthError(err) };
  }
}

async function logIn(email, password) {
  if (!auth) return { ok: false, message: "Accounts aren't connected yet." };
  try {
    await signInWithEmailAndPassword(auth, email.trim(), password);
    return { ok: true, message: "Welcome back!" };
  } catch (err) {
    return { ok: false, message: friendlyAuthError(err) };
  }
}

async function logOut() {
  if (!auth) return;
  await signOut(auth);
}

function onAuthChange(callback) {
  if (!auth) { callback(null); return () => {}; }
  return onAuthStateChanged(auth, callback);
}

function friendlyAuthError(err) {
  const code = err && err.code ? err.code : "";
  if (code.includes("email-already-in-use")) return "That email already has an account — try logging in instead.";
  if (code.includes("invalid-email")) return "That email doesn't look right.";
  if (code.includes("weak-password")) return "Please use at least 6 characters for your password.";
  if (code.includes("user-not-found") || code.includes("wrong-password") || code.includes("invalid-credential")) return "Email or password doesn't match our records.";
  return "Something went wrong. Please try again.";
}

/* ============================================================
   ADMIN (Saga) — password lives in Firestore, checked client-side.
   See the security note at the top of this file.
   ============================================================ */

const DEFAULT_ADMIN_PASSWORD = "sagahtml";

async function checkAdminPassword(inputPassword) {
  if (!db) return inputPassword === DEFAULT_ADMIN_PASSWORD;
  try {
    const ref = doc(db, "admin_config", "settings");
    const snap = await getDoc(ref);
    const storedPassword = snap.exists() ? snap.data().password : DEFAULT_ADMIN_PASSWORD;

    if (!snap.exists()) {
      await setDoc(ref, { password: DEFAULT_ADMIN_PASSWORD, updatedAt: serverTimestamp() });
    }
    return inputPassword === storedPassword;
  } catch (err) {
    console.warn("[BLL] Admin check failed, falling back to default:", err);
    return inputPassword === DEFAULT_ADMIN_PASSWORD;
  }
}

async function changeAdminPassword(newPassword) {
  if (!db || !newPassword || newPassword.length < 4) {
    return { ok: false, message: "Password must be at least 4 characters." };
  }
  try {
    await setDoc(doc(db, "admin_config", "settings"), {
      password: newPassword,
      updatedAt: serverTimestamp()
    });
    return { ok: true, message: "Admin password updated." };
  } catch (err) {
    return { ok: false, message: "Could not update password. Try again." };
  }
}

function adminSessionActive() {
  return sessionStorage.getItem("bll_saga_session") === "true";
}
function setAdminSession(active) {
  if (active) sessionStorage.setItem("bll_saga_session", "true");
  else sessionStorage.removeItem("bll_saga_session");
}

/* ============================================================
   SAGA DATA READS (dashboard queries)
   ============================================================ */

async function getAllVisitors() {
  if (!db) return [];
  const snap = await getDocs(query(collection(db, "visitors"), orderBy("timestamp", "desc")));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function getAllDecoyVisits() {
  if (!db) return [];
  const snap = await getDocs(query(collection(db, "decoy_visits"), orderBy("timestamp", "desc")));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function getAllSubscribers() {
  if (!db) return [];
  const snap = await getDocs(query(collection(db, "subscribers"), orderBy("subscribedAt", "desc")));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function getAllComments() {
  if (!db) return [];
  const snap = await getDocs(query(collection(db, "comments"), orderBy("timestamp", "desc")));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function deleteComment(commentId) {
  if (!db) return { ok: false };
  try {
    await deleteDoc(doc(db, "comments", commentId));
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

async function getAllUsers() {
  if (!db) return [];
  const snap = await getDocs(query(collection(db, "users"), orderBy("joinedAt", "desc")));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function getAllLikes() {
  if (!db) return [];
  const snap = await getDocs(collection(db, "post_likes"));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/* ============================================================
   PUBLIC API
   ============================================================ */
window.BLL = {
  logVisit, logDecoyVisit,
  subscribeEmail,
  addComment, watchComments,
  toggleLike, getLikeState,
  signUp, logIn, logOut, onAuthChange,
  checkAdminPassword, changeAdminPassword, adminSessionActive, setAdminSession,
  getAllVisitors, getAllDecoyVisits, getAllSubscribers, getAllComments, deleteComment, getAllUsers, getAllLikes
};

// Every normal page logs a visit automatically.
// admin.html sets window.BLL_SKIP_AUTO_VISIT_LOG = true before this
// script loads, and logs to decoy_visits itself instead.
if (!window.BLL_SKIP_AUTO_VISIT_LOG) {
  logVisit();
}
