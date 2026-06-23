/**
 * Kage Dashboard Module
 * Fetches and displays user's image history with status, previews, and download actions.
 * Exposes `KageDashboard` globally.
 */

(function () {
  "use strict";

  /**
   * Load and render all images for the current user.
   * @param {string} containerId - ID of the grid container
   * @param {object} opts
   * @param {number} opts.limit - Max images to load
   */
  async function loadDashboard(containerId, opts = {}) {
    const { limit = 50 } = opts;
    const container = document.getElementById(containerId);
    if (!container) return;

    const user = window.KageAuth?.getUser?.();
    if (!user) {
      container.innerHTML = `
        <div class="empty-state">
          <span class="empty-state-icon">🔒</span>
          <h3>Sign in to view your dashboard</h3>
          <p class="text-muted">Your translated images will appear here.</p>
        </div>`;
      return;
    }

    container.innerHTML = `
      <div class="empty-state">
        <span class="spinner"></span>
        <p class="text-muted mt-2">Loading your images...</p>
      </div>`;

    const client = window.KageAuth?.getSupabaseClient?.();
    if (!client) {
      container.innerHTML = `<div class="empty-state"><p class="text-muted">Connection error</p></div>`;
      return;
    }

    const { data, error } = await client
      .from("images")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      container.innerHTML = `
        <div class="empty-state">
          <span class="empty-state-icon">⚠️</span>
          <h3>Failed to load images</h3>
          <p class="text-muted">${escapeHTML(error.message)}</p>
        </div>`;
      return;
    }

    if (!data || data.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <span class="empty-state-icon">📭</span>
          <h3>No images yet</h3>
          <p class="text-muted">Upload some manga or images to get started!</p>
          <a href="/upload.html" class="btn btn-primary mt-2">Upload Images</a>
        </div>`;
      return;
    }

    renderImageCards(container, data);
  }

  function renderImageCards(container, images) {
    container.innerHTML = images
      .map((img) => {
        const statusLabel = getStatusLabel(img.status);
        const statusClass = getStatusClass(img.status);
        const date = formatDate(img.created_at);
        const previewUrl = img.translated_url || img.original_url || "";
        const hasTranslated = img.status === "completed" && img.translated_url;

        return `
        <div class="image-card" data-id="${img.id}">
          <img
            class="image-card-img"
            src="${previewUrl}"
            alt="${escapeHTML(img.original_name || "Image")}"
            loading="lazy"
            onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22200%22 height=%22260%22><rect fill=%22%2316161c%22 width=%22200%22 height=%22260%22/><text fill=%22%235c5860%22 x=%2250%25%22 y=%2250%25%22 text-anchor=%22middle%22 dy=%22.3em%22 font-size=%2214%22>No Preview</text></svg>'"
          />
          <div class="image-card-body">
            <div class="image-card-name" title="${escapeHTML(img.original_name || "Untitled")}">
              ${escapeHTML(img.original_name || "Untitled")}
            </div>
            <div class="image-card-meta">
              <span class="status-badge ${statusClass}">${statusLabel}</span>
              <span>${date}</span>
            </div>
          </div>
          <div class="image-card-actions">
            <button class="btn btn-secondary btn-sm preview-btn" data-id="${img.id}">
              👁 Preview
            </button>
            ${hasTranslated
              ? `<a href="${img.translated_url}" class="btn btn-primary btn-sm" download target="_blank" rel="noopener">
                   ⬇ Download
                 </a>`
              : `<button class="btn btn-ghost btn-sm" disabled>⏳ Pending</button>`
            }
          </div>
        </div>`;
      })
      .join("");

    // Bind preview buttons
    container.querySelectorAll(".preview-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const img = images.find((i) => i.id === btn.dataset.id);
        if (img) showPreviewModal(img);
      });
    });
  }

  function showPreviewModal(image) {
    // Remove existing modal
    const existing = document.querySelector(".modal-overlay");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";

    const originalLabel = image.status === "completed" ? "Original" : "Image";
    const hasBoth = image.status === "completed" && image.translated_url;

    overlay.innerHTML = `
      <div class="modal">
        <h3>${escapeHTML(image.original_name || "Image")}</h3>
        <div class="result-comparison" style="${hasBoth ? "" : "grid-template-columns: 1fr;"}">
          <div class="result-pane">
            <div class="result-pane-header">${originalLabel}</div>
            <img src="${image.original_url}" alt="Original" />
          </div>
          ${hasBoth ? `
          <div class="result-pane">
            <div class="result-pane-header">Translated</div>
            <img src="${image.translated_url}" alt="Translated" />
          </div>` : ""}
        </div>
        ${image.ocr_text ? `
        <div class="mt-2">
          <p class="text-muted" style="font-size:0.8rem;">OCR Text:</p>
          <p style="font-size:0.85rem;background:var(--bg-surface);padding:0.5rem;border-radius:var(--radius-sm);max-height:100px;overflow-y:auto;">${escapeHTML(image.ocr_text)}</p>
        </div>` : ""}
        ${image.translated_text ? `
        <div class="mt-1">
          <p class="text-muted" style="font-size:0.8rem;">Translation:</p>
          <p style="font-size:0.85rem;background:var(--bg-surface);padding:0.5rem;border-radius:var(--radius-sm);max-height:100px;overflow-y:auto;">${escapeHTML(image.translated_text)}</p>
        </div>` : ""}
        <div class="modal-actions">
          ${image.translated_url ? `<a href="${image.translated_url}" class="btn btn-primary btn-sm" download>⬇ Download Translated</a>` : ""}
          <button class="btn btn-secondary btn-sm close-modal">Close</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    overlay.querySelector(".close-modal").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });
  }

  function getStatusLabel(status) {
    const map = {
      uploaded: "Uploaded",
      processing: "Processing",
      ocr_done: "OCR Done",
      translating: "Translating",
      translating_done: "Translated",
      inpainting: "Cleaning",
      inpainting_done: "Cleaned",
      rendering: "Rendering",
      completed: "Completed",
      failed: "Failed",
    };
    return map[status] || status || "Unknown";
  }

  function getStatusClass(status) {
    if (status === "completed") return "completed";
    if (status === "failed") return "failed";
    if (status === "uploaded") return "uploaded";
    return "processing";
  }

  function formatDate(isoString) {
    if (!isoString) return "";
    const d = new Date(isoString);
    const now = new Date();
    const diffMs = now - d;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
    });
  }

  /**
   * Delete an image record and its storage files.
   */
  async function deleteImage(imageId, userId) {
    const client = window.KageAuth?.getSupabaseClient?.();
    if (!client) return { error: "Not authenticated" };

    // Get the image record first to find storage paths
    const { data: img } = await client
      .from("images")
      .select("original_url, translated_url")
      .eq("id", imageId)
      .single();

    // Delete from database
    const { error } = await client.from("images").delete().eq("id", imageId).eq("user_id", userId);

    if (error) return { error: error.message };

    // Try to delete storage files (best effort)
    if (img) {
      const paths = [];
      if (img.original_url) paths.push(extractStoragePath(img.original_url, "originals"));
      if (img.translated_url) paths.push(extractStoragePath(img.translated_url, "translated"));

      for (const path of paths) {
        if (path) {
          const bucket = path.bucket;
          const filePath = path.filePath;
          try {
            await client.storage.from(bucket).remove([filePath]);
          } catch (_) {
            // Ignore storage delete errors
          }
        }
      }
    }

    return { success: true };
  }

  function extractStoragePath(url, bucket) {
    try {
      const urlObj = new URL(url);
      const pathParts = urlObj.pathname.split("/");
      const bucketIdx = pathParts.indexOf(bucket);
      if (bucketIdx >= 0) {
        return {
          bucket,
          filePath: pathParts.slice(bucketIdx + 1).join("/"),
        };
      }
    } catch (_) {}
    return null;
  }

  function escapeHTML(str) {
    const div = document.createElement("div");
    div.textContent = str || "";
    return div.innerHTML;
  }

  window.KageDashboard = {
    loadDashboard,
    deleteImage,
    showPreviewModal,
  };
})();
