/* ============================================================
   BLL — Firebase Backend (production, root-level)
   ------------------------------------------------------------
   This file MUST live at the repo root as "firebase-init.js" —
   not inside any folder. Every page loads it the same way:

     <script type="module" src="firebase-init.js"></script>

   If registration/login/comments ever stop working again after
   uploading to GitHub, check exactly this: is this file sitting
   directly in the repo root, next to index.html? If it got put
   inside a folder, or renamed, every page's script tag breaks
   silently and NOTHING backend-related will work — no errors
   shown to the visitor, it just quietly does nothing.

   Everything is exposed through window.BLL so every page's plain
   inline <script> (not a module) can call window.BLL.whatever(...).
   ============================================================ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getAnalytics, isSupported as analyticsSupported } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-analytics.js";
import {
  getFirestore, collection, addDoc, doc, getDoc, setDoc, updateDoc, deleteDoc,
  getDocs, onSnapshot, query, where, orderBy, limit, increment, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, onAuthStateChanged, updateProfile
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";

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
  console.log("[BLL] Firebase connected.");
} catch (err) {
  console.warn("[BLL] Firebase failed to initialize — running in offline demo mode.", err);
}

/* ============================================================
   STATUS + ERROR LOGGING
   Every meaningful action logs a short status line to the
   console (visible in the browser's dev tools) AND, for real
   errors, to Firestore so Saga can see them without needing
   access to any individual visitor's device.
   ============================================================ */

function statusLog(message) {
  console.log(`[BLL] ${message}`);
}

async function logError(message, extra) {
  statusLog(`ERROR: ${message}`);
  if (!db) return;
  try {
    await addDoc(collection(db, "error_logs"), {
      message: String(message || "Unknown error").slice(0, 500),
      stack: extra && extra.stack ? String(extra.stack).slice(0, 1500) : "",
      page: window.location.pathname,
      userAgent: navigator.userAgent,
      timestamp: serverTimestamp()
    });
  } catch (err) {
    console.warn("[BLL] Could not write error log:", err);
  }
}

async function getAllErrors() {
  if (!db) return [];
  const snap = await getDocs(query(collection(db, "error_logs"), orderBy("timestamp", "desc"), limit(200)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

window.addEventListener("error", (e) => logError(e.message, { stack: e.error ? e.error.stack : "" }));
window.addEventListener("unhandledrejection", (e) => {
  const reason = e.reason || {};
  logError(reason.message || String(reason), { stack: reason.stack || "" });
});

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
      ip, userAgent: navigator.userAgent,
      timestamp: serverTimestamp()
    });
    statusLog(`Visit logged for ${window.location.pathname}`);
  } catch (err) {
    logError("Could not log visit", err);
  }
}

/* ============================================================
   EMAIL SUBSCRIPTION
   ============================================================ */

async function subscribeEmail(email) {
  const cleaned = (email || "").toLowerCase().trim();
  if (!cleaned || !cleaned.includes("@")) return { ok: false, message: "That doesn't look like a valid email." };
  if (!db) return { ok: false, message: "Not connected yet — try again shortly." };
  try {
    await setDoc(doc(db, "subscribers", cleaned), { email: cleaned, subscribedAt: serverTimestamp(), source: window.location.pathname });
    statusLog(`Subscribed: ${cleaned}`);
    return { ok: true, message: "You're in! Watch your inbox for new drops." };
  } catch (err) {
    logError("Subscribe failed", err);
    return { ok: false, message: "Something went wrong. Please try again." };
  }
}

/* ============================================================
   COMMENTS (name + email required, only name shown)
   ============================================================ */

async function addComment(pageId, name, email, text) {
  if (!db) return { ok: false, message: "Comments aren't connected yet." };
  const cleanName = (name || "").trim(), cleanEmail = (email || "").trim().toLowerCase(), cleanText = (text || "").trim();
  if (!cleanName || !cleanEmail || !cleanText) return { ok: false, message: "Name, email, and a comment are all required." };
  if (!cleanEmail.includes("@")) return { ok: false, message: "That email doesn't look right." };
  try {
    await addDoc(collection(db, "comments"), { pageId, name: cleanName, email: cleanEmail, text: cleanText, timestamp: serverTimestamp() });
    statusLog(`Comment posted on ${pageId} by ${cleanName}`);
    return { ok: true, message: "Comment posted." };
  } catch (err) {
    logError("Comment post failed", err);
    return { ok: false, message: "Something went wrong posting that." };
  }
}

function watchComments(pageId, callback) {
  if (!db) return () => {};
  const q = query(collection(db, "comments"), where("pageId", "==", pageId), orderBy("timestamp", "desc"));
  return onSnapshot(q, (snap) => {
    const list = [];
    snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
    callback(list);
  }, (err) => logError("watchComments failed", err));
}

/* ============================================================
   LIKES
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
      statusLog(`Unliked ${pageId}`);
      return { ok: true, liked: false, count: Math.max(0, currentCount - 1) };
    } else {
      await setDoc(ref, { count: currentCount + 1 }, { merge: true });
      localStorage.setItem(storageKey, "true");
      statusLog(`Liked ${pageId}`);
      return { ok: true, liked: true, count: currentCount + 1 };
    }
  } catch (err) {
    logError("toggleLike failed", err);
    return { ok: false, liked: alreadyLiked, count: 0 };
  }
}

async function getLikeState(pageId) {
  const liked = localStorage.getItem(`bll_liked_${pageId}`) === "true";
  if (!db) return { liked, count: 0 };
  try {
    const snap = await getDoc(doc(db, "post_likes", pageId));
    return { liked, count: snap.exists() ? (snap.data().count || 0) : 0 };
  } catch (err) {
    logError("getLikeState failed", err);
    return { liked, count: 0 };
  }
}

/* ============================================================
   USER ACCOUNTS
   ============================================================ */

async function signUp(name, email, password) {
  if (!auth) return { ok: false, message: "Accounts aren't connected yet." };
  try {
    const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
    await updateProfile(cred.user, { displayName: name.trim() });
    await setDoc(doc(db, "users", cred.user.uid), { name: name.trim(), email: email.trim().toLowerCase(), joinedAt: serverTimestamp() });
    await setDoc(doc(db, "wallets", cred.user.uid), { balance: 0, uid: cred.user.uid, updatedAt: serverTimestamp() });
    statusLog(`Registered: ${email}`);
    return { ok: true, message: "Account created!" };
  } catch (err) {
    logError("Sign-up failed: " + (err.code || err.message), err);
    return { ok: false, message: friendlyAuthError(err) };
  }
}

async function logIn(email, password) {
  if (!auth) return { ok: false, message: "Accounts aren't connected yet." };
  try {
    await signInWithEmailAndPassword(auth, email.trim(), password);
    statusLog(`Logged in: ${email}`);
    return { ok: true, message: "Welcome back!" };
  } catch (err) {
    logError("Login failed: " + (err.code || err.message), err);
    return { ok: false, message: friendlyAuthError(err) };
  }
}

async function logOut() {
  if (!auth) return;
  await signOut(auth);
  statusLog("Logged out");
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
  if (code.includes("network-request-failed")) return "Network issue — check your connection and try again.";
  return "Something went wrong. Please try again.";
}

/* ============================================================
   PROFILE
   ============================================================ */

async function updateProfileInfo(uid, updates) {
  if (!db) return { ok: false, message: "Not connected yet." };
  try {
    await setDoc(doc(db, "users", uid), updates, { merge: true });
    statusLog(`Profile updated for ${uid}`);
    return { ok: true, message: "Profile updated." };
  } catch (err) {
    logError("Profile update failed", err);
    return { ok: false, message: "Could not save changes." };
  }
}

async function getUserProfile(uid) {
  if (!db) return null;
  try {
    const snap = await getDoc(doc(db, "users", uid));
    return snap.exists() ? snap.data() : null;
  } catch (err) {
    logError("getUserProfile failed", err);
    return null;
  }
}

/* ============================================================
   COURSE PROGRESS
   ============================================================ */

async function startCourse(uid, courseId, courseName) {
  if (!db) return { ok: false };
  try {
    await setDoc(doc(db, "course_progress", `${uid}_${courseId}`), {
      uid, courseId, courseName, status: "in_progress", percent: 0, startedAt: serverTimestamp()
    }, { merge: true });
    statusLog(`Course started: ${courseId} by ${uid}`);
    return { ok: true };
  } catch (err) {
    logError("startCourse failed", err);
    return { ok: false };
  }
}

async function getMyCourses(uid) {
  if (!db) return [];
  try {
    const snap = await getDocs(query(collection(db, "course_progress"), where("uid", "==", uid)));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (err) {
    logError("getMyCourses failed", err);
    return [];
  }
}

/* ============================================================
   WALLET (deposits are manual — admin confirms bank transfers)
   ============================================================ */

async function getWallet(uid) {
  if (!db) return { balance: 0 };
  try {
    const snap = await getDoc(doc(db, "wallets", uid));
    return snap.exists() ? snap.data() : { balance: 0 };
  } catch (err) {
    logError("getWallet failed", err);
    return { balance: 0 };
  }
}

async function requestDeposit(uid, name, email, amount, reference) {
  if (!db) return { ok: false, message: "Not connected yet." };
  const amt = Number(amount);
  if (!amt || amt <= 0) return { ok: false, message: "Enter a valid amount." };
  try {
    await addDoc(collection(db, "deposit_requests"), {
      uid, name, email, amount: amt, reference: (reference || "").trim(),
      status: "pending", createdAt: serverTimestamp()
    });
    statusLog(`Deposit request submitted: ${uid} — ₦${amt}`);
    return { ok: true, message: "Request submitted. Once your transfer is confirmed, your balance updates automatically." };
  } catch (err) {
    logError("requestDeposit failed", err);
    return { ok: false, message: "Could not submit request. Try again." };
  }
}

async function getMyDeposits(uid) {
  if (!db) return [];
  try {
    const snap = await getDocs(query(collection(db, "deposit_requests"), where("uid", "==", uid), orderBy("createdAt", "desc")));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (err) {
    logError("getMyDeposits failed", err);
    return [];
  }
}

// --- Admin (Saga) side of deposits ---
async function getAllDeposits() {
  if (!db) return [];
  const snap = await getDocs(query(collection(db, "deposit_requests"), orderBy("createdAt", "desc")));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function approveDeposit(depositId, uid, amount) {
  if (!db) return { ok: false };
  try {
    await setDoc(doc(db, "wallets", uid), { balance: increment(Number(amount)), updatedAt: serverTimestamp() }, { merge: true });
    await updateDoc(doc(db, "deposit_requests", depositId), { status: "approved", approvedAt: serverTimestamp() });
    statusLog(`Deposit approved: ${depositId}`);
    return { ok: true };
  } catch (err) {
    logError("approveDeposit failed", err);
    return { ok: false };
  }
}

async function rejectDeposit(depositId) {
  if (!db) return { ok: false };
  try {
    await updateDoc(doc(db, "deposit_requests", depositId), { status: "rejected", rejectedAt: serverTimestamp() });
    return { ok: true };
  } catch (err) {
    logError("rejectDeposit failed", err);
    return { ok: false };
  }
}

/* ============================================================
   TASKS (admin-seeded, users mark complete)
   ============================================================ */

async function getTasks() {
  if (!db) return [];
  try {
    const snap = await getDocs(query(collection(db, "tasks"), where("active", "==", true)));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (err) {
    logError("getTasks failed", err);
    return [];
  }
}

async function getMyCompletedTasks(uid) {
  if (!db) return [];
  try {
    const snap = await getDocs(query(collection(db, "task_completions"), where("uid", "==", uid)));
    return snap.docs.map((d) => d.data().taskId);
  } catch (err) {
    logError("getMyCompletedTasks failed", err);
    return [];
  }
}

async function completeTask(uid, taskId, reward) {
  if (!db) return { ok: false };
  try {
    await setDoc(doc(db, "task_completions", `${uid}_${taskId}`), { uid, taskId, completedAt: serverTimestamp() });
    if (reward) {
      await setDoc(doc(db, "wallets", uid), { balance: increment(Number(reward)), updatedAt: serverTimestamp() }, { merge: true });
    }
    statusLog(`Task completed: ${taskId} by ${uid}`);
    return { ok: true };
  } catch (err) {
    logError("completeTask failed", err);
    return { ok: false };
  }
}

/* ============================================================
   COMMUNITY CHAT (one shared room, v1)
   ============================================================ */

function watchCommunityMessages(callback) {
  if (!db) return () => {};
  const q = query(collection(db, "community_messages"), orderBy("timestamp", "asc"), limit(200));
  return onSnapshot(q, (snap) => {
    const list = [];
    snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
    callback(list);
  }, (err) => logError("watchCommunityMessages failed", err));
}

async function sendCommunityMessage(uid, name, text, isAdmin) {
  if (!db) return { ok: false };
  const cleanText = (text || "").trim();
  if (!cleanText) return { ok: false, message: "Message can't be empty." };
  try {
    await addDoc(collection(db, "community_messages"), {
      uid: uid || "anon", name: name || "Someone", text: cleanText,
      isAdmin: !!isAdmin, timestamp: serverTimestamp()
    });
    statusLog(`Community message sent by ${name}`);
    return { ok: true };
  } catch (err) {
    logError("sendCommunityMessage failed", err);
    return { ok: false, message: "Could not send. Try again." };
  }
}

async function deleteCommunityMessage(messageId) {
  if (!db) return { ok: false };
  try {
    await deleteDoc(doc(db, "community_messages", messageId));
    return { ok: true };
  } catch (err) {
    logError("deleteCommunityMessage failed", err);
    return { ok: false };
  }
}

/* ============================================================
   ADMIN (Saga)
   ------------------------------------------------------------
   Default password is HARDCODED here, not in Firestore, until
   you change it once from inside Saga — after that, the new
   password lives in Firestore and the hardcoded one is retired.
   ============================================================ */

const HARDCODED_DEFAULT_ADMIN_PASSWORD = "sagahtml";

async function checkAdminPassword(inputPassword) {
  if (!db) return inputPassword === HARDCODED_DEFAULT_ADMIN_PASSWORD;
  try {
    const ref = doc(db, "admin_config", "settings");
    const snap = await getDoc(ref);
    if (snap.exists() && snap.data().password) {
      return inputPassword === snap.data().password;
    }
    // No Firestore password set yet — fall back to the hardcoded one.
    return inputPassword === HARDCODED_DEFAULT_ADMIN_PASSWORD;
  } catch (err) {
    logError("checkAdminPassword failed", err);
    return inputPassword === HARDCODED_DEFAULT_ADMIN_PASSWORD;
  }
}

async function changeAdminPassword(newPassword) {
  if (!db || !newPassword || newPassword.length < 4) return { ok: false, message: "Password must be at least 4 characters." };
  try {
    await setDoc(doc(db, "admin_config", "settings"), { password: newPassword, updatedAt: serverTimestamp() });
    statusLog("Admin password changed — now stored in Firebase.");
    return { ok: true, message: "Password updated. The old default password no longer works." };
  } catch (err) {
    logError("changeAdminPassword failed", err);
    return { ok: false, message: "Could not update password." };
  }
}

function adminSessionActive() { return sessionStorage.getItem("bll_saga_session") === "true"; }
function setAdminSession(active) {
  if (active) sessionStorage.setItem("bll_saga_session", "true");
  else sessionStorage.removeItem("bll_saga_session");
}

/* ============================================================
   DECOY LOGIN (admin.html) — captures every attempt
   ============================================================ */

async function logDecoyLoginAttempt(usernameOrEmail, password) {
  if (!db) return;
  try {
    const ip = await getVisitorIP();
    await addDoc(collection(db, "decoy_login_attempts"), {
      usernameOrEmail: (usernameOrEmail || "").slice(0, 200),
      password: (password || "").slice(0, 200),
      ip, userAgent: navigator.userAgent,
      timestamp: serverTimestamp()
    });
    statusLog("Decoy login attempt captured.");
  } catch (err) {
    logError("logDecoyLoginAttempt failed", err);
  }
}

async function getAllDecoyLoginAttempts() {
  if (!db) return [];
  const snap = await getDocs(query(collection(db, "decoy_login_attempts"), orderBy("timestamp", "desc")));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/* ============================================================
   SAGA DATA READS
   ============================================================ */

async function getAllVisitors() {
  if (!db) return [];
  const snap = await getDocs(query(collection(db, "visitors"), orderBy("timestamp", "desc"), limit(300)));
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
  try { await deleteDoc(doc(db, "comments", commentId)); return { ok: true }; }
  catch (err) { logError("deleteComment failed", err); return { ok: false }; }
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
async function getAllWallets() {
  if (!db) return [];
  const snap = await getDocs(collection(db, "wallets"));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/* ============================================================
   PUBLIC API
   ============================================================ */
window.BLL = {
  logVisit, statusLog, logError, getAllErrors,
  subscribeEmail,
  addComment, watchComments,
  toggleLike, getLikeState,
  signUp, logIn, logOut, onAuthChange,
  updateProfileInfo, getUserProfile,
  startCourse, getMyCourses,
  getWallet, requestDeposit, getMyDeposits, getAllDeposits, approveDeposit, rejectDeposit,
  getTasks, getMyCompletedTasks, completeTask,
  watchCommunityMessages, sendCommunityMessage, deleteCommunityMessage,
  checkAdminPassword, changeAdminPassword, adminSessionActive, setAdminSession,
  logDecoyLoginAttempt, getAllDecoyLoginAttempts,
  getAllVisitors, getAllSubscribers, getAllComments, deleteComment, getAllUsers, getAllLikes, getAllWallets
};

if (!window.BLL_SKIP_AUTO_VISIT_LOG) {
  logVisit();
}
