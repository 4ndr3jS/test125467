/**
 * Kage Upload Module
 * Handles file selection, preview, drag-and-drop, and uploading to Supabase Storage.
 * Exposes `KageUpload` globally.
 */

(function () {
  "use strict";

  let selectedFiles = [];

  /**
   * Initialize a drop zone + file input.
   * @param {object} opts
   * @param {string} opts.dropZoneId - ID of the drop zone element
   * @param {string} opts.fileInputId - ID of the hidden file input
   * @param {string} opts.previewContainerId - ID of the preview grid container
   * @param {function} opts.onFilesChanged - callback(files[]) when selection changes
   * @param {boolean} opts.multiple - allow multiple files
   */
  function initDropZone(opts) {
    const dropZone = document.getElementById(opts.dropZoneId);
    const fileInput = document.getElementById(opts.fileInputId);
    const previewContainer = document.getElementById(opts.previewContainerId);

    if (!dropZone || !fileInput) return;

    // Click to open file dialog
    dropZone.addEventListener("click", (e) => {
      if (e.target === fileInput) return;
      fileInput.click();
    });

    fileInput.addEventListener("change", () => {
      addFiles(Array.from(fileInput.files), opts);
      fileInput.value = "";
    });

    // Drag & drop
    dropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropZone.classList.add("drag-over");
    });

    dropZone.addEventListener("dragleave", () => {
      dropZone.classList.remove("drag-over");
    });

    dropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropZone.classList.remove("drag-over");
      const files = Array.from(e.dataTransfer.files).filter((f) =>
        f.type.startsWith("image/")
      );
      addFiles(files, opts);
    });

    // Folder drop support
    dropZone.addEventListener("drop", (e) => {
      const items = e.dataTransfer.items;
      if (!items) return;
      const filePromises = [];
      for (const item of items) {
        if (item.kind === "file") {
          filePromises.push(item.getAsFile());
        }
      }
      Promise.all(filePromises).then((files) => {
        const imageFiles = files.filter((f) => f && f.type.startsWith("image/"));
        if (imageFiles.length > 0) {
          addFiles(imageFiles, opts);
        }
      });
    });
  }

  function addFiles(newFiles, opts) {
    if (!opts.multiple) {
      selectedFiles = [newFiles[0]];
    } else {
      // Deduplicate by name + size
      for (const f of newFiles) {
        const exists = selectedFiles.some(
          (sf) => sf.name === f.name && sf.size === f.size
        );
        if (!exists) {
          selectedFiles.push(f);
        }
      }
    }

    renderPreviews(opts.previewContainerId);
    if (opts.onFilesChanged) opts.onFilesChanged(selectedFiles);
  }

  function renderPreviews(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = selectedFiles
      .map((file, i) => {
        const url = URL.createObjectURL(file);
        return `
        <div class="upload-preview-item" data-index="${i}">
          <img src="${url}" alt="${escapeHTML(file.name)}" loading="lazy" />
          <button class="remove-btn" data-index="${i}" title="Remove">✕</button>
          <span class="preview-name">${escapeHTML(file.name)}</span>
        </div>`;
      })
      .join("");

    // Bind remove buttons
    container.querySelectorAll(".remove-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.index, 10);
        removeFile(idx, containerId);
      });
    });
  }

  function removeFile(index, containerId) {
    selectedFiles.splice(index, 1);
    renderPreviews(containerId);
  }

  function getFiles() {
    return selectedFiles;
  }

  function clearFiles(containerId) {
    selectedFiles = [];
    if (containerId) renderPreviews(containerId);
  }

  /**
   * Upload a single file to Supabase Storage.
   * @returns {Promise<{publicUrl: string, path: string, error?: string}>}
   */
  async function uploadFile(file, userId, folder) {
    const client = window.KageAuth?.getSupabaseClient?.();
    if (!client) return { error: "Not authenticated" };

    const timestamp = Date.now();
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `${userId}/${folder || "originals"}/${timestamp}_${safeName}`;

    const { data, error } = await client.storage
      .from("originals")
      .upload(path, file, {
        cacheControl: "3600",
        contentType: file.type,
      });

    if (error) return { error: error.message };

    const { data: urlData } = client.storage
      .from("originals")
      .getPublicUrl(path);

    return { publicUrl: urlData?.publicUrl || "", path };
  }

  /**
   * Upload multiple files and return an array of results.
   */
  async function uploadFiles(files, userId, folder, onProgress) {
    const results = [];
    for (let i = 0; i < files.length; i++) {
      const result = await uploadFile(files[i], userId, folder);
      results.push(result);
      if (onProgress) onProgress(i + 1, files.length, result);
    }
    return results;
  }

  /**
   * Insert image records into Supabase DB.
   */
  async function createImageRecords(userId, uploadResults, sourceLang, targetLang) {
    const client = window.KageAuth?.getSupabaseClient?.();
    if (!client) return [];

    const rows = uploadResults.map((r) => ({
      user_id: userId,
      original_url: r.publicUrl,
      original_name: r.path.split("/").pop() || "unknown",
      status: "uploaded",
      source_lang: sourceLang || "ja",
      target_lang: targetLang || "en",
    }));

    const { data, error } = await client.from("images").insert(rows).select();

    if (error) {
      console.error("createImageRecords error:", error);
      return [];
    }

    return data || [];
  }

  function escapeHTML(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  window.KageUpload = {
    initDropZone,
    getFiles,
    clearFiles,
    uploadFile,
    uploadFiles,
    createImageRecords,
  };
})();
