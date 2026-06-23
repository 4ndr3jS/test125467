/**
 * Kage Auth Module
 * Handles Supabase authentication: sign up, log in, log out, session management.
 * Exposes a global `KageAuth` object used by all pages.
 */

(function () {
  "use strict";

  const SUPABASE_URL = window.ENV?.SUPABASE_URL || "";
  const SUPABASE_ANON_KEY = window.ENV?.SUPABASE_ANON_KEY || "";

  let supabase = null;
  let currentUser = null;
  let session = null;

  function initClient() {
    if (supabase) return supabase;
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      console.error("KageAuth: Supabase credentials not set. Define window.ENV before loading auth.js");
      return null;
    }
    supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    return supabase;
  }

  async function getSession() {
    const client = initClient();
    if (!client) return null;
    const { data, error } = await client.auth.getSession();
    if (error) {
      console.error("getSession error:", error);
      return null;
    }
    session = data.session;
    currentUser = data.session?.user || null;
    return session;
  }

  async function signUp(email, password) {
    const client = initClient();
    if (!client) return { error: "Supabase client not initialized" };

    const { data, error } = await client.auth.signUp({ email, password });
    if (error) return { error: error.message };

    currentUser = data.user || null;
    session = data.session || null;
    return { user: currentUser, session };
  }

  async function signIn(email, password) {
    const client = initClient();
    if (!client) return { error: "Supabase client not initialized" };

    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) return { error: error.message };

    currentUser = data.user || null;
    session = data.session || null;
    return { user: currentUser, session };
  }

  async function signOut() {
    const client = initClient();
    if (!client) return;
    await client.auth.signOut();
    currentUser = null;
    session = null;
  }

  function getUser() {
    return currentUser;
  }

  function getSupabaseClient() {
    return initClient();
  }

  async function requireAuth() {
    await getSession();
    if (!currentUser) {
      window.location.href = "/index.html";
      return null;
    }
    return currentUser;
  }

  // Listen for auth state changes
  function onAuthStateChange(callback) {
    const client = initClient();
    if (!client) return;
    client.auth.onAuthStateChange((event, newSession) => {
      session = newSession;
      currentUser = newSession?.user || null;
      callback(event, newSession);
    });
  }

  /**
   * Render the navbar with user info and auth-aware links.
   * @param {string} containerId - ID of the navbar container element
   * @param {string} currentPage - Page name for active link highlighting
   */
  async function renderNavbar(containerId, currentPage) {
    await getSession();
    const container = document.getElementById(containerId);
    if (!container) return;

    const isLoggedIn = !!currentUser;
    const email = currentUser?.email || "";

    const pages = [
      { name: "Home", href: "/index.html", key: "index" },
      { name: "Upload", href: "/upload.html", key: "upload", auth: true },
      { name: "Dashboard", href: "/dashboard.html", key: "dashboard", auth: true },
      { name: "Settings", href: "/settings.html", key: "settings", auth: true },
    ];

    const linksHTML = pages
      .filter((p) => !p.auth || isLoggedIn)
      .map((p) => {
        const active = currentPage === p.key ? " active" : "";
        return `<a href="${p.href}" class="${active}">${p.name}</a>`;
      })
      .join("");

    const userHTML = isLoggedIn
      ? `<span class="user-badge hide-mobile"><span class="user-dot"></span>${escapeHTML(email)}</span>
         <button class="btn-logout" id="nav-logout-btn">Log out</button>`
      : "";

    container.innerHTML = `
      <div class="container">
        <a href="/index.html" class="navbar-brand">
          <span class="logo-mark">影</span>
          Kage
        </a>
        <nav class="navbar-links">
          ${linksHTML}
          ${userHTML}
        </nav>
      </div>
    `;

    // Bind logout button
    const logoutBtn = document.getElementById("nav-logout-btn");
    if (logoutBtn) {
      logoutBtn.addEventListener("click", async () => {
        await signOut();
        window.location.href = "/index.html";
      });
    }
  }

  function escapeHTML(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // Expose globally
  window.KageAuth = {
    initClient,
    getSession,
    signUp,
    signIn,
    signOut,
    getUser,
    getSupabaseClient,
    requireAuth,
    onAuthStateChange,
    renderNavbar,
  };
})();
