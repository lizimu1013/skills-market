const state = {
  skills: [],
  category: "all",
  query: "",
  detailToken: 0
};

const grid = document.querySelector("#skillGrid");
const emptyState = document.querySelector("#emptyState");
const searchInput = document.querySelector("#searchInput");
const skillCount = document.querySelector("#skillCount");
const downloadCount = document.querySelector("#downloadCount");
const uploadForm = document.querySelector("#uploadForm");
const formStatus = document.querySelector("#formStatus");
const fileInput = document.querySelector("#fileInput");
const fileLabel = document.querySelector("#fileLabel");
const dropzone = document.querySelector("#dropzone");
const detailModal = document.querySelector("#detailModal");
const detailBody = document.querySelector("#detailBody");
const detailFileName = document.querySelector("#detailFileName");
const skillDetailCache = new Map();

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    const map = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    };
    return map[char];
  });
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function allSkills() {
  return state.skills;
}

function skillFileName(skill) {
  return skill.filename || `${skill.title}.md`;
}

function skillPackageName(skill) {
  return skillFileName(skill);
}

function skillDate(skill) {
  return new Date(skill.createdAt || Date.now()).toISOString().slice(0, 10);
}

function skillPopularity(skill) {
  return Number(skill.downloads || 0).toLocaleString();
}

function skillStarCount(skill) {
  return Number(skill.downloads || 0).toLocaleString();
}

function skillForkCount(skill) {
  return "0";
}

function skillDownloadHref(skill) {
  return `/api/skills/${encodeURIComponent(skill.id)}/download`;
}

function skillDetailHref(skill) {
  return `/skills/${encodeURIComponent(skill.id)}`;
}

function skillSearchText(skill) {
  const fileName = skillFileName(skill);
  const extension = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")) : "";
  return [
    skill.id,
    skill.title,
    skill.description,
    skill.author,
    skill.category,
    skill.version,
    skill.createdAt,
    fileName,
    extension,
    fileName.replace(/\./g, " "),
    ...(skill.tags || [])
  ]
    .join(" ")
    .toLowerCase();
}

function parseFrontmatter(markdown) {
  const normalized = String(markdown || "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { attrs: {}, body: normalized.trim() };
  }

  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (endIndex === -1) {
    return { attrs: {}, body: normalized.trim() };
  }

  const attrs = {};
  lines.slice(1, endIndex).forEach((line) => {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) return;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    attrs[match[1]] = value;
  });

  return {
    attrs,
    body: lines.slice(endIndex + 1).join("\n").trim()
  };
}

function renderInlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function renderMarkdown(markdown) {
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let paragraph = [];
  let listType = "";
  let codeLines = [];
  let inFence = false;
  let inIndentedCode = false;

  const closeParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${renderInlineMarkdown(paragraph.join(" "))}</p>`);
    paragraph = [];
  };

  const closeList = () => {
    if (!listType) return;
    html.push(`</${listType}>`);
    listType = "";
  };

  const closeCode = () => {
    if (!codeLines.length && !inIndentedCode && !inFence) return;
    html.push(`<pre><code>${escapeHtml(codeLines.join("\n")).replace(/\n+$/, "")}</code></pre>`);
    codeLines = [];
    inIndentedCode = false;
  };

  const openList = (type) => {
    if (listType === type) return;
    closeParagraph();
    closeList();
    listType = type;
    html.push(`<${type}>`);
  };

  lines.forEach((line) => {
    const trimmed = line.trim();

    if (inFence) {
      if (/^```/.test(trimmed)) {
        inFence = false;
        closeCode();
      } else {
        codeLines.push(line);
      }
      return;
    }

    if (/^```/.test(trimmed)) {
      closeParagraph();
      closeList();
      inFence = true;
      codeLines = [];
      return;
    }

    if (/^( {4}|\t)/.test(line)) {
      closeParagraph();
      closeList();
      inIndentedCode = true;
      codeLines.push(line.replace(/^\t/, "  ").replace(/^ {4}/, ""));
      return;
    }

    if (inIndentedCode) {
      if (!trimmed) {
        codeLines.push("");
        return;
      }
      closeCode();
    }

    if (!trimmed) {
      closeParagraph();
      closeList();
      return;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (heading) {
      closeParagraph();
      closeList();
      const level = Math.min(heading[1].length + 2, 6);
      const idAttr = html.length ? "" : ' id="detailTitle"';
      html.push(`<h${level}${idAttr}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      return;
    }

    const unordered = /^[-*]\s+(.+)$/.exec(trimmed);
    if (unordered) {
      openList("ul");
      html.push(`<li>${renderInlineMarkdown(unordered[1])}</li>`);
      return;
    }

    const ordered = /^\d+[.)]\s+(.+)$/.exec(trimmed);
    if (ordered) {
      openList("ol");
      html.push(`<li>${renderInlineMarkdown(ordered[1])}</li>`);
      return;
    }

    if (/^>\s+/.test(trimmed)) {
      closeParagraph();
      closeList();
      html.push(`<blockquote>${renderInlineMarkdown(trimmed.replace(/^>\s+/, ""))}</blockquote>`);
      return;
    }

    paragraph.push(trimmed);
  });

  closeParagraph();
  closeList();
  closeCode();
  return html.join("");
}

function renderFrontmatterGrid(attrs, fallbackSkill) {
  const entries = Object.entries(attrs || {});
  const rows = entries.length
    ? entries
    : [
        ["name", fallbackSkill.title],
        ["description", fallbackSkill.description]
      ];

  return rows
    .map(([key, value]) => `
      <div class="front-key">${escapeHtml(key)}</div>
      <div class="front-value">${renderInlineMarkdown(value)}</div>
    `)
    .join("");
}

function flattenFiles(nodes) {
  return nodes.flatMap((node) => {
    if (node.type === "dir") return flattenFiles(node.children || []);
    return [node];
  });
}

function currentSkills() {
  return allSkills().filter((skill) => {
    const matchesQuery = skillSearchText(skill).includes(state.query.toLowerCase().trim());
    const matchesCategory = state.category === "all" || skill.category === state.category;
    return matchesQuery && matchesCategory;
  });
}

function renderStats() {
  const combined = allSkills();
  skillCount.textContent = combined.length;
  document.querySelector("#heroSkillCount").textContent = combined.length.toLocaleString();
  downloadCount.textContent = combined.reduce((sum, skill) => sum + Number(skill.downloads || 0), 0);
}

function renderSkills() {
  const skills = currentSkills();
  grid.innerHTML = skills
    .map((skill) => {
      const tags = (skill.tags || [])
        .map((tag) => `<span class="tag">#${escapeHtml(tag)}</span>`)
        .join("");
      const href = skillDownloadHref(skill);
      const fileName = skillFileName(skill);
      const date = skillDate(skill);
      return `
        <article class="skill-card" data-skill-id="${escapeHtml(skill.id)}" tabindex="0" role="link" aria-label="Open ${escapeHtml(fileName)} details">
          <div class="file-head">
            <span class="dot red"></span>
            <span class="dot yellow"></span>
            <span class="dot green"></span>
            <strong>${escapeHtml(fileName)}</strong>
            <span class="stars">★ ${escapeHtml(skillPopularity(skill))}</span>
          </div>
          <div class="skill-body">
            <div class="repo-line">from <span>"${escapeHtml(skill.author || "anonymous")}"</span></div>
            <p>${escapeHtml(skill.description)}</p>
            <div class="meta">
              <span>${escapeHtml(skill.category || "General")}</span>
              <span>${escapeHtml(skill.version || "v0.1.0")}</span>
              ${tags}
            </div>
          </div>
          <div class="card-footer">
            <span>${date}</span>
            <span class="file-size">${escapeHtml(formatBytes(skill.size))}</span>
            <a class="download-link" href="${href}">download</a>
          </div>
        </article>
      `;
    })
    .join("");

  emptyState.hidden = Boolean(skills.length);
  renderStats();
}

async function loadSkills() {
  const response = await fetch("/api/skills");
  if (!response.ok) throw new Error("Unable to load skills.");
  const data = await response.json();
  state.skills = data.skills || [];
  renderSkills();
}

function setStatus(message, type = "") {
  formStatus.textContent = message;
  formStatus.className = type;
}

function findSkill(id) {
  return allSkills().find((skill) => skill.id === id);
}

async function loadSkillDetail(skill) {
  if (skillDetailCache.has(skill.id)) return skillDetailCache.get(skill.id);
  const response = await fetch(`/api/skills/${encodeURIComponent(skill.id)}`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Unable to load skill detail.");
  skillDetailCache.set(skill.id, data);
  return data;
}

function renderDetailChrome(skill, options = {}) {
  const tags = (skill.tags || []).map((tag) => `<span class="tag">#${escapeHtml(tag)}</span>`).join("");
  const fileName = skillFileName(skill);
  const packageName = skillPackageName(skill);
  const downloadHref = skillDownloadHref(skill);
  const fileCount = options.fileCount ?? 1;
  const treeHtml = options.treeHtml || `
    <div class="tree-row child active">
      <span>▤</span>
      <span>${escapeHtml(fileName)}</span>
      <em>${escapeHtml(formatBytes(skill.size || 0))}</em>
    </div>
  `;
  const frontmatterHtml = options.frontmatterHtml || renderFrontmatterGrid({}, skill);
  const markdownHtml = options.markdownHtml || `
    <p>${escapeHtml(skill.description)}</p>
    <p>正在读取上传包里的 SKILL.md。</p>
  `;
  const sourceHtml = options.sourceHtml || "local upload";

  detailFileName.textContent = fileName;
  detailBody.innerHTML = `
    <section class="detail-stat-terminal">
      <div class="terminal-command">$ git log --oneline --stat</div>
      <div class="terminal-stats">
        <span class="stat-stars">☆ stars: <strong>${escapeHtml(skillStarCount(skill))}</strong></span>
        <span class="stat-forks">⌘ forks: <strong>${escapeHtml(skillForkCount(skill))}</strong></span>
        <span class="stat-updated">▣ updated: <strong>${skillDate(skill)} 09:11</strong></span>
      </div>
    </section>

    <section class="file-browser" data-file-browser>
      <div class="browser-title">
        <div>
          <span class="dot red"></span>
          <span class="dot yellow"></span>
          <span class="dot green"></span>
          <span>文件资源管理器</span>
        </div>
        <span>${escapeHtml(fileCount)} 个文件</span>
      </div>
      <div class="file-tree">
        ${treeHtml}
      </div>
      <div class="browser-caret">⌃</div>
    </section>

    <section class="skill-document">
      <div class="doc-title">
        <div>
          <span class="dot red"></span>
          <span class="dot yellow"></span>
          <span class="dot green"></span>
          <span>SKILL.md</span>
        </div>
        <span>readonly</span>
      </div>
      <div class="frontmatter-grid">
        <div class="front-key">package</div>
        <div class="front-value">${escapeHtml(packageName)}</div>
        <div class="front-key">source</div>
        <div class="front-value">${sourceHtml}</div>
        ${frontmatterHtml}
      </div>
      <article class="markdown-preview">
        ${markdownHtml}
      </article>
      <div class="detail-actions">
        <div class="detail-meta">${tags}</div>
        <a class="button primary detail-download" href="${downloadHref}">download ${escapeHtml(packageName)}</a>
      </div>
    </section>
  `;
}

function renderTree(nodes, selectedPath, level = 0) {
  return (nodes || []).map((node) => {
    const indent = Math.min(level * 22, 88);
    const isSelected = node.path === selectedPath;
    if (node.type === "dir") {
      return `
        <div class="tree-node" data-tree-node>
          <button class="tree-row folder" type="button" data-toggle-tree aria-expanded="true" style="--tree-indent: ${indent}px">
            <span class="tree-caret">⌄</span>
            <span>▱</span>
            <strong>${escapeHtml(node.name)}</strong>
            <em></em>
          </button>
          <div class="tree-children">${renderTree(node.children || [], selectedPath, level + 1)}</div>
        </div>
      `;
    }
    return `
      <div class="tree-row child${isSelected ? " active" : ""}" style="--tree-indent: ${indent}px">
        <span>${node.name.endsWith(".yaml") || node.name.endsWith(".yml") ? "♧" : "▤"}</span>
        <span>${escapeHtml(node.name)}</span>
        <em>${escapeHtml(formatBytes(node.size || 0))}</em>
      </div>
    `;
  }).join("");
}

function renderLoadingDetail(skill) {
  renderDetailChrome(skill, {
    fileCount: "...",
    treeHtml: `
      <div class="tree-row child active">
        <span>▤</span>
        <span>正在读取 SKILL.md...</span>
        <em></em>
      </div>
    `,
    frontmatterHtml: renderFrontmatterGrid({}, skill),
    markdownHtml: `<p class="muted-line">正在从上传包加载 SKILL.md...</p>`
  });
}

async function renderUploadedDetail(skill, token) {
  try {
    const detail = await loadSkillDetail(skill);
    if (token !== state.detailToken) return;
    const skillFile = detail.files.find((file) => file.isSkillFile) || detail.files.find((file) => file.name === "SKILL.md") || detail.files[0];
    const markdown = detail.markdown || "";
    const parsed = parseFrontmatter(markdown);
    renderDetailChrome(skill, {
      fileCount: detail.files.length,
      treeHtml: renderTree(detail.tree, skillFile?.path),
      frontmatterHtml: renderFrontmatterGrid(parsed.attrs, skill),
      markdownHtml: markdown
        ? renderMarkdown(parsed.body || markdown)
        : `<p class="muted-line">这个上传包里没有找到 SKILL.md。</p>`
    });
  } catch (error) {
    if (token !== state.detailToken) return;
    renderDetailChrome(skill, {
      fileCount: 0,
      treeHtml: `
        <div class="tree-row child">
          <span>!</span>
          <span>SKILL.md 读取失败</span>
          <em></em>
        </div>
      `,
      markdownHtml: `<p class="muted-line">${escapeHtml(error.message)}</p>`
    });
  }
}

function renderDetail(skill) {
  if (!skill) return;
  const token = state.detailToken + 1;
  state.detailToken = token;
  renderLoadingDetail(skill);
  renderUploadedDetail(skill, token);
}

function openDetail(id, pushState = true) {
  const skill = findSkill(id);
  if (!skill) return;
  renderDetail(skill);
  detailModal.hidden = false;
  document.body.classList.add("modal-open");
  if (pushState) {
    history.pushState({ skillId: id }, "", skillDetailHref(skill));
  }
}

function closeDetail(pushState = true) {
  detailModal.hidden = true;
  document.body.classList.remove("modal-open");
  if (pushState && location.pathname.startsWith("/skills/")) {
    history.pushState({}, "", "/");
    document.querySelector("#market").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

document.querySelectorAll(".filter").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".filter").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    state.category = button.dataset.category;
    renderSkills();
  });
});

searchInput.addEventListener("input", (event) => {
  state.query = event.target.value;
  renderSkills();
});

fileInput.addEventListener("change", () => {
  fileLabel.textContent = fileInput.files[0]?.name || "Drop skill package here";
});

dropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropzone.classList.add("dragover");
});

dropzone.addEventListener("dragleave", () => {
  dropzone.classList.remove("dragover");
});

dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropzone.classList.remove("dragover");
  if (event.dataTransfer.files.length) {
    fileInput.files = event.dataTransfer.files;
    fileLabel.textContent = event.dataTransfer.files[0].name;
  }
});

grid.addEventListener("click", (event) => {
  const downloadLink = event.target.closest(".download-link");
  if (downloadLink) {
    setTimeout(loadSkills, 600);
    return;
  }

  const card = event.target.closest(".skill-card");
  if (card?.dataset.skillId) {
    openDetail(card.dataset.skillId);
  }
});

grid.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const card = event.target.closest(".skill-card");
  if (!card?.dataset.skillId) return;
  event.preventDefault();
  openDetail(card.dataset.skillId);
});

detailModal.addEventListener("click", (event) => {
  if (event.target.closest("[data-close-detail]")) {
    closeDetail();
    return;
  }

  const treeToggle = event.target.closest("[data-toggle-tree]");
  if (treeToggle) {
    const treeNode = treeToggle.closest("[data-tree-node]");
    const collapsed = treeNode?.classList.toggle("collapsed");
    treeToggle.setAttribute("aria-expanded", String(!collapsed));
    return;
  }

  const detailDownload = event.target.closest(".detail-download");
  if (detailDownload) {
    setTimeout(loadSkills, 600);
  }
});

window.addEventListener("popstate", () => {
  const detailMatch = /^\/skills\/([^/]+)\/?$/.exec(location.pathname);
  if (detailMatch) {
    openDetail(decodeURIComponent(detailMatch[1]), false);
  } else {
    closeDetail(false);
  }
});

uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus("Uploading package...");

  const submitButton = uploadForm.querySelector("button[type='submit']");
  submitButton.disabled = true;

  try {
    const response = await fetch("/api/skills", {
      method: "POST",
      body: new FormData(uploadForm)
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Upload failed.");
    }

    uploadForm.reset();
    fileLabel.textContent = "Drop skill package here";
    setStatus(`Uploaded ${data.skill.title}. It is now available for download.`, "success");
    await loadSkills();
    document.querySelector("#market").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    submitButton.disabled = false;
  }
});

loadSkills()
  .then(() => {
    const detailMatch = /^\/skills\/([^/]+)\/?$/.exec(location.pathname);
    if (detailMatch) {
      openDetail(decodeURIComponent(detailMatch[1]), false);
    }
  })
  .catch((error) => {
    setStatus(error.message, "error");
    renderSkills();
  });
