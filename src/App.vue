<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

interface PageMeta {
  slug: string
  title: string
  type: string | null
  tags: string[]
  updated: string | null
  created: string | null
  layer: string
  wikiManaged: boolean
  excerpt: string
}
interface PageDetail {
  slug: string
  frontmatter: { title: string; type: string | null; tags: string[]; sources: string[]; updated: string | null }
  content: string
}
interface DirNode {
  path: string
  name: string
  pages: PageMeta[]
  children: DirNode[]
  count: number
}
interface TreeRow {
  kind: 'dir' | 'page'
  name: string
  path: string
  depth: number
  page?: PageMeta
}

const pages = ref<PageMeta[]>([])
const query = ref('')
const searchInput = ref<HTMLInputElement | null>(null)
const onlyWiki = ref(true)
const detail = ref<PageDetail | null>(null)
const error = ref('')
const pagesLoading = ref(true)
const detailLoading = ref(false)
const dark = ref(false)
const viewMode = ref<'timeline' | 'tree'>('timeline')
const collapsed = ref<Set<string>>(new Set()) // tree folders collapsed by user; default fully expanded
const navOpen = ref(false) // mobile drawer state (desktop: nav always visible)
const basenameToSlug = new Map<string, string>()
let loadRequest = 0

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  return pages.value.filter((p) => {
    if (onlyWiki.value && !p.wikiManaged) return false
    if (!q) return true
    return (p.title + ' ' + p.tags.join(' ') + ' ' + p.excerpt).toLowerCase().includes(q)
  })
})

const tree = computed(() => {
  const rootPages: PageMeta[] = []
  const children: DirNode[] = []
  const counts = new Map<string, number>()
  const byPath = new Map<string, DirNode>()
  for (const p of filtered.value) {
    const parts = p.slug.split('/')
    if (parts.length === 1) {
      rootPages.push(p)
      continue
    }
    let parent = children
    let cur = ''
    for (const d of parts.slice(0, -1)) {
      cur = cur ? `${cur}/${d}` : d
      let node = byPath.get(cur)
      if (!node) {
        node = { path: cur, name: d, pages: [], children: [], count: 0 }
        byPath.set(cur, node)
        parent.push(node)
      }
      parent = node.children
    }
    byPath.get(cur)!.pages.push(p)
  }
  const count = (n: DirNode): number => {
    n.count = n.pages.length + n.children.reduce((s, c) => s + count(c), 0)
    counts.set(n.path, n.count)
    return n.count
  }
  children.forEach(count)
  const sort = (nodes: DirNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name))
    for (const n of nodes) {
      n.pages.sort((a, b) => a.title.localeCompare(b.title))
      sort(n.children)
    }
  }
  sort(children)
  return { rootPages, children, counts }
})

const treeRows = computed<TreeRow[]>(() => {
  const rows: TreeRow[] = []
  const t = tree.value
  for (const p of t.rootPages) {
    rows.push({ kind: 'page', name: p.title, path: p.slug, depth: 0, page: p })
  }
  const walk = (nodes: DirNode[], depth: number) => {
    for (const n of nodes) {
      rows.push({ kind: 'dir', name: n.name, path: n.path, depth })
      if (collapsed.value.has(n.path)) continue
      for (const p of n.pages) {
        rows.push({ kind: 'page', name: p.title, path: p.slug, depth: depth + 1, page: p })
      }
      walk(n.children, depth + 1)
    }
  }
  walk(t.children, 0)
  return rows
})

function toggleDir(path: string) {
  const s = new Set(collapsed.value)
  if (s.has(path)) s.delete(path)
  else s.add(path)
  collapsed.value = s
}

function applyTheme() {
  document.documentElement.dataset.theme = dark.value ? 'dark' : 'light'
}
function toggleTheme() {
  dark.value = !dark.value
  localStorage.setItem('wiki-theme', dark.value ? 'dark' : 'light')
  applyTheme()
}

function onKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    searchInput.value?.focus()
  }
  if (e.key === 'Escape') navOpen.value = false
}

async function loadPages() {
  pagesLoading.value = true
  error.value = ''
  try {
    const res = await fetch('/api/pages')
    if (!res.ok) throw new Error(`Could not load notes (${res.status})`)
    pages.value = (await res.json()).pages
    basenameToSlug.clear()
    for (const p of pages.value) {
      const base = p.slug.split('/').pop()!
      if (!basenameToSlug.has(base)) basenameToSlug.set(base, p.slug)
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    pagesLoading.value = false
  }
}

onMounted(async () => {
  const saved = localStorage.getItem('wiki-theme')
  dark.value = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches
  applyTheme()
  window.addEventListener('hashchange', onHashChange)
  window.addEventListener('keydown', onKeydown)
  await loadPages()
  onHashChange() // deep link / restored history entry
})

onUnmounted(() => {
  window.removeEventListener('hashchange', onHashChange)
  window.removeEventListener('keydown', onKeydown)
})

function currentSlug(): string | null {
  const m = location.hash.match(/^#\/p\/(.+)$/)
  return m ? decodeURIComponent(m[1]) : null
}

function open(slug: string) {
  navOpen.value = false // close mobile drawer when a note is picked
  const want = '#/p/' + encodeURIComponent(slug)
  if (location.hash === want) {
    load(slug) // clicking the already-open page: no hash change, load anyway
  } else {
    location.hash = want // hashchange listener loads the page
  }
}

async function load(slug: string) {
  const request = ++loadRequest
  detailLoading.value = true
  error.value = ''
  try {
    const encodedSlug = slug.split('/').map(encodeURIComponent).join('/')
    const res = await fetch('/api/page/' + encodedSlug)
    if (!res.ok) throw new Error(res.status === 404 ? 'This note no longer exists.' : `Could not load note (${res.status})`)
    const page = await res.json()
    if (request === loadRequest) detail.value = page
  } catch (e) {
    if (request === loadRequest) {
      detail.value = null
      error.value = e instanceof Error ? e.message : String(e)
    }
  } finally {
    if (request === loadRequest) detailLoading.value = false
  }
}

function onHashChange() {
  const slug = currentSlug()
  if (slug) load(slug)
  else {
    loadRequest++
    detailLoading.value = false
    detail.value = null
  }
}

function sourceHref(s: string): string | null {
  const slug = s.replace(/\.md$/, '')
  return pages.value.some((p) => p.slug === slug) ? '#/p/' + encodeURIComponent(slug) : null
}

const rendered = computed(() => {
  if (!detail.value) return ''
  const md = detail.value.content.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_m, target: string, alias?: string) => `[${alias ?? target}](#/p/${encodeURIComponent(target)})`,
  )
  return DOMPurify.sanitize(marked.parse(md, { async: false }) as string)
})

function onLink(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest('a')
  if (!a) return
  const m = a.hash.match(/^#\/p\/(.+)$/)
  if (!m) return
  const target = decodeURIComponent(m[1])
  const slug = pages.value.some((p) => p.slug === target)
    ? target
    : basenameToSlug.get(target)
  if (!slug) {
    e.preventDefault() // dangling link: no-op
    return
  }
  if (slug !== target) {
    e.preventDefault() // alias resolved to real slug: navigate via hash ourselves
    location.hash = '#/p/' + encodeURIComponent(slug)
  }
  // exact slug: let the browser follow the href -> hashchange -> load
}
</script>

<template>
  <div class="app">
    <a class="skip-link" href="#content">Skip to note</a>
    <header class="topbar">
      <div class="brand">
        <button class="nav-toggle" :aria-label="navOpen ? 'Close navigation' : 'Open navigation'" @click="navOpen = !navOpen">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
        </button>
        <a class="brand-link" href="#">
          <span class="brand-mark" aria-hidden="true">W</span>
          <span>
            <h1>LLM Wiki</h1>
            <span class="sub">{{ pagesLoading ? 'Reading vault…' : `${pages.length} notes in the vault` }}</span>
          </span>
        </a>
      </div>
      <div class="controls">
        <label class="search-wrap">
          <span class="sr-only">Search notes</span>
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg>
          <input ref="searchInput" v-model="query" class="search" type="search" placeholder="Search the vault" />
          <kbd>⌘ K</kbd>
        </label>
        <label class="toggle" title="Only show notes managed by llm_wiki">
          <input v-model="onlyWiki" type="checkbox" />
          <span class="switch" aria-hidden="true"></span>
          <span>Wiki only</span>
        </label>
        <button
          class="theme-btn"
          :aria-label="dark ? 'Switch to light mode' : 'Switch to dark mode'"
          :title="dark ? 'Switch to light mode' : 'Switch to dark mode'"
          @click="toggleTheme"
        >
          <svg v-if="dark" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
          <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M20 15.3A8.5 8.5 0 0 1 8.7 4a8.5 8.5 0 1 0 11.3 11.3Z" /></svg>
        </button>
      </div>
    </header>

    <div v-if="error" class="error" role="alert">
      <span>{{ error }}</span>
      <button v-if="!pages.length" @click="loadPages">Try again</button>
    </div>

    <main class="main">
      <div v-if="navOpen" class="backdrop" @click="navOpen = false"></div>
      <aside class="list" :class="{ open: navOpen }" aria-label="Note navigation">
        <div class="list-head">
          <div class="viewswitch">
            <button :class="{ on: viewMode === 'timeline' }" :aria-pressed="viewMode === 'timeline'" @click="viewMode = 'timeline'">Recent</button>
            <button :class="{ on: viewMode === 'tree' }" :aria-pressed="viewMode === 'tree'" @click="viewMode = 'tree'">Folders</button>
          </div>
          <span class="count">{{ filtered.length }} shown</span>
        </div>
        <div v-if="pagesLoading" class="list-loading" aria-label="Loading notes">
          <span v-for="n in 6" :key="n" class="skeleton-row"></span>
        </div>
        <div v-else-if="!filtered.length" class="empty-list">
          <span aria-hidden="true">⌕</span>
          <strong>No matching notes</strong>
          <p>Try a different phrase or include the full vault.</p>
        </div>
        <ul v-else-if="viewMode === 'timeline'">
          <li
            v-for="p in filtered"
            :key="p.slug"
          >
            <button
              class="note-row"
              :class="{ active: detail?.slug === p.slug }"
              :aria-current="detail?.slug === p.slug ? 'page' : undefined"
              @click="open(p.slug)"
            >
              <span class="row1">
                <span class="badge" :class="p.layer">{{ p.layer }}</span>
                <span class="date">{{ (p.updated || '').slice(0, 10) }}</span>
              </span>
              <span class="title">{{ p.title }}</span>
              <span class="excerpt">{{ p.excerpt }}</span>
            </button>
          </li>
        </ul>
        <div v-else class="tree">
          <div
            v-for="r in treeRows"
            :key="r.kind + r.path"
            class="trow"
            :style="{ paddingLeft: r.depth * 16 + 6 + 'px' }"
          >
            <button v-if="r.kind === 'dir'" class="trow-dir" @click="toggleDir(r.path)">
              <span class="caret">{{ collapsed.has(r.path) ? '▸' : '▾' }}</span>
              <span class="tname">{{ r.name }}</span>
              <span class="tcount">{{ tree.counts.get(r.path) }}</span>
            </button>
            <button
              v-else
              class="trow-page"
              :class="{ active: detail?.slug === r.path }"
              :aria-current="detail?.slug === r.path ? 'page' : undefined"
              @click="open(r.page!.slug)"
            >
              {{ r.name }}
            </button>
          </div>
        </div>
      </aside>

      <section id="content" class="detail" tabindex="-1" @click="onLink">
        <div v-if="detailLoading" class="article-loading" aria-label="Loading note">
          <span class="skeleton eyebrow-skeleton"></span>
          <span class="skeleton title-skeleton"></span>
          <span class="skeleton meta-skeleton"></span>
          <span v-for="n in 7" :key="n" class="skeleton copy-skeleton" :style="{ width: `${96 - (n % 3) * 11}%` }"></span>
        </div>
        <div v-else-if="!detail" class="placeholder">
          <span class="placeholder-mark" aria-hidden="true">W</span>
          <p class="eyebrow">Your knowledge, in context</p>
          <h2>Choose a note to begin reading.</h2>
          <p>Browse recent writing or use folders to follow the structure of your vault.</p>
        </div>
        <article v-else class="note">
          <header class="note-header">
            <p class="eyebrow">{{ detail.slug }}</p>
            <h2>{{ detail.frontmatter.title }}</h2>
            <div class="meta">
              <span v-if="detail.frontmatter.type" class="type">{{ detail.frontmatter.type }}</span>
              <span v-for="t in detail.frontmatter.tags" :key="t" class="tag">#{{ t }}</span>
              <span v-if="detail.frontmatter.updated" class="date">Updated {{ detail.frontmatter.updated.slice(0, 10) }}</span>
            </div>
            <div v-if="detail.frontmatter.sources.length" class="sources">
              <strong>Sources</strong>
              <span v-for="s in detail.frontmatter.sources" :key="s" class="src-wrap">
                <a v-if="sourceHref(s)" class="src" :href="sourceHref(s)">{{ s }}</a>
                <span v-else class="src">{{ s }}</span>
              </span>
            </div>
          </header>
          <div class="content" v-html="rendered"></div>
        </article>
      </section>
    </main>
  </div>
</template>

<style>
:root {
  --bg: #f0eee7;
  --fg: #262922;
  --surface: #f8f7f2;
  --surface-strong: #fffefa;
  --hover: #ecefe7;
  --active: #e3e9dc;
  --border: #d8d9cf;
  --border-soft: #e8e8df;
  --muted: #6d7168;
  --faint: #999c92;
  --accent: #536b4e;
  --accent-strong: #3f553b;
  --link: #496745;
  --code-bg: #eeeee7;
  --tag-bg: #eff1ea;
  --badge-bg: #e7e7df;
  --badge-fg: #555b50;
  --wiki-badge-bg: #e1e9dc;
  --wiki-badge-fg: #476043;
  --raw-badge-bg: #eee5d3;
  --raw-badge-fg: #785f34;
  --error: #9b3933;
  --blockquote-fg: #5f675b;
  --shadow: rgba(53, 61, 48, 0.12);
  color-scheme: light;
}
[data-theme='dark'] {
  --bg: #141713;
  --fg: #e9ebe3;
  --surface: #1a1e19;
  --surface-strong: #20241e;
  --hover: #272d24;
  --active: #30392d;
  --border: #363c33;
  --border-soft: #2a3028;
  --muted: #a4aa9e;
  --faint: #737a70;
  --accent: #9aaf8f;
  --accent-strong: #b1c3a8;
  --link: #b0c9a5;
  --code-bg: #292e27;
  --tag-bg: #2b3229;
  --badge-bg: #30352e;
  --badge-fg: #c9cec3;
  --wiki-badge-bg: #30402d;
  --wiki-badge-fg: #bfd2b5;
  --raw-badge-bg: #463d29;
  --raw-badge-fg: #dec78f;
  --error: #f0a09a;
  --blockquote-fg: #b1b8ac;
  --shadow: rgba(0, 0, 0, 0.3);
  color-scheme: dark;
}
* {
  box-sizing: border-box;
}
html,
body,
#app {
  height: 100%;
  margin: 0;
}
html,
body {
  overflow-x: hidden; /* never wider than the viewport (mobile zoom-out guard) */
}
body {
  font-family: 'Avenir Next', Avenir, 'Segoe UI', sans-serif;
  color: var(--fg);
  background:
    radial-gradient(circle at 84% -10%, color-mix(in srgb, var(--accent) 12%, transparent), transparent 34rem),
    var(--bg);
  transition: background-color 0.2s, color 0.2s;
}
.app {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.topbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 24px;
  min-height: 74px;
  padding: 12px clamp(16px, 2.5vw, 36px);
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--surface) 88%, transparent);
  backdrop-filter: blur(18px);
}
.brand {
  display: flex;
  align-items: center;
  min-width: max-content;
}
.brand h1 {
  font-family: 'Iowan Old Style', 'Palatino Linotype', Georgia, serif;
  font-size: 21px;
  line-height: 1.05;
  letter-spacing: -0.025em;
  margin: 0;
}
.brand-link {
  display: flex;
  align-items: center;
  gap: 11px;
  color: var(--fg);
  text-decoration: none;
}
.brand-mark,
.placeholder-mark {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 12px 12px 5px 12px;
  background: var(--accent);
  color: var(--surface-strong);
  font: 600 19px/1 'Iowan Old Style', Georgia, serif;
  box-shadow: 0 8px 20px var(--shadow);
}
.sub {
  display: block;
  margin-top: 3px;
  color: var(--muted);
  font-size: 11px;
  letter-spacing: 0.01em;
}
.controls {
  display: flex;
  align-items: center;
  gap: 12px;
}
.search-wrap {
  display: flex;
  align-items: center;
  width: min(30vw, 360px);
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 11px;
  background: var(--surface-strong);
  transition: border-color 0.2s, box-shadow 0.2s;
}
.search-wrap:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 16%, transparent);
}
.search-wrap svg,
.theme-btn svg,
.nav-toggle svg {
  width: 18px;
  height: 18px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.search-wrap svg {
  color: var(--faint);
  flex: 0 0 auto;
}
.search {
  min-width: 0;
  flex: 1;
  padding: 9px 9px;
  border: 0;
  font-size: 14px;
  background: transparent;
  color: var(--fg);
  outline: 0;
}
.search::placeholder {
  color: var(--faint);
}
.search-wrap kbd {
  padding: 2px 5px;
  border: 1px solid var(--border);
  border-radius: 5px;
  color: var(--faint);
  background: var(--surface);
  font: 10px/1.4 ui-monospace, monospace;
}
.toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}
.toggle input {
  position: absolute;
  opacity: 0;
}
.switch {
  width: 30px;
  height: 18px;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--badge-bg);
  transition: background-color 0.2s, border-color 0.2s;
}
.switch::after {
  content: '';
  display: block;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--surface-strong);
  box-shadow: 0 1px 3px var(--shadow);
  transition: transform 0.2s;
}
.toggle input:checked + .switch {
  border-color: var(--accent);
  background: var(--accent);
}
.toggle input:checked + .switch::after {
  transform: translateX(12px);
}
.theme-btn {
  border: 1px solid var(--border);
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: 11px;
  background: var(--surface-strong);
  color: var(--fg);
  font-size: 15px;
  line-height: 1;
  padding: 0;
  cursor: pointer;
  transition: transform 0.2s, background-color 0.2s;
}
.theme-btn:hover {
  background: var(--hover);
  transform: translateY(-1px);
}
.nav-toggle {
  display: none; /* mobile-only drawer trigger */
}
.skip-link {
  position: fixed;
  top: 8px;
  left: 8px;
  z-index: 100;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--accent-strong);
  color: var(--surface-strong);
  transform: translateY(-150%);
}
.skip-link:focus {
  transform: none;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
button,
a,
input {
  font: inherit;
}
button:focus-visible,
a:focus-visible,
input:focus-visible,
.toggle:has(input:focus-visible) {
  outline: 3px solid color-mix(in srgb, var(--accent) 34%, transparent);
  outline-offset: 2px;
}
.error {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin: 0;
  padding: 8px 20px;
  border-bottom: 1px solid color-mix(in srgb, var(--error) 30%, var(--border));
  background: color-mix(in srgb, var(--error) 8%, var(--surface));
  color: var(--error);
  font-size: 13px;
}
.error button {
  border: 0;
  background: none;
  color: inherit;
  font-weight: 700;
  text-decoration: underline;
  cursor: pointer;
}
.main {
  flex: 1;
  display: flex;
  min-height: 0;
  background: var(--surface-strong);
}
.list {
  width: clamp(320px, 27vw, 390px);
  flex: 0 0 clamp(320px, 27vw, 390px);
  border-right: 1px solid var(--border);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  scrollbar-color: var(--border) transparent;
}
.list-head {
  padding: 14px 18px 12px;
  border-bottom: 1px solid var(--border-soft);
  position: sticky;
  top: 0;
  background: color-mix(in srgb, var(--surface) 94%, transparent);
  backdrop-filter: blur(12px);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  z-index: 1;
}
.viewswitch {
  display: flex;
  gap: 3px;
  padding: 3px;
  border-radius: 9px;
  background: var(--code-bg);
}
.viewswitch button {
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--muted);
  font-size: 11px;
  font-weight: 600;
  padding: 5px 11px;
  cursor: pointer;
  transition: color 0.2s, background-color 0.2s, box-shadow 0.2s;
}
.viewswitch button.on {
  background: var(--surface-strong);
  color: var(--fg);
  box-shadow: 0 1px 4px var(--shadow);
}
.count {
  font-size: 11px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.tree {
  padding-bottom: 8px;
}
.trow {
  display: flex;
  align-items: center;
}
.trow-dir {
  display: flex;
  align-items: center;
  gap: 4px;
  border: none;
  background: none;
  color: var(--fg);
  font-size: 12px;
  font-weight: 600;
  padding: 7px 0;
  cursor: pointer;
  width: 100%;
  text-align: left;
}
.trow-dir:hover {
  color: var(--link);
}
.caret {
  font-size: 10px;
  color: var(--muted);
  width: 12px;
}
.tname {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tcount {
  margin-left: auto;
  padding-right: 10px;
  font-size: 11px;
  color: var(--faint);
  font-weight: 400;
}
.trow-page {
  width: 100%;
  border: 0;
  font-size: 13px;
  padding: 7px 8px 7px 6px;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--fg);
  border-left: 2px solid transparent;
  background: transparent;
  text-align: left;
  transition: background-color 0.18s;
}
.trow-page:hover {
  background: var(--hover);
}
.trow-page.active {
  background: var(--active);
  border-left-color: var(--accent);
}
.list ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
.list li {
  padding: 0 10px;
}
.note-row {
  display: block;
  width: 100%;
  padding: 13px 12px 14px;
  border: 0;
  border-bottom: 1px solid var(--border-soft);
  border-radius: 0;
  background: transparent;
  color: var(--fg);
  text-align: left;
  cursor: pointer;
  transition: background-color 0.2s, transform 0.2s;
}
.note-row:hover {
  border-radius: 10px;
  background: var(--hover);
  transform: translateX(2px);
}
.note-row.active {
  border-radius: 10px;
  background: var(--active);
  box-shadow: inset 3px 0 var(--accent);
}
.row1 {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}
.badge {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 3px 7px;
  border-radius: 4px;
  background: var(--badge-bg);
  color: var(--badge-fg);
}
.badge.entities,
.badge.concepts,
.badge.comparisons,
.badge.queries {
  background: var(--wiki-badge-bg);
  color: var(--wiki-badge-fg);
}
.badge.raw {
  background: var(--raw-badge-bg);
  color: var(--raw-badge-fg);
}
.title {
  display: block;
  font-family: 'Iowan Old Style', 'Palatino Linotype', Georgia, serif;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;
  margin-bottom: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.excerpt {
  display: block;
  font-size: 11px;
  line-height: 1.5;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.date {
  font-size: 11px;
  color: var(--faint);
  font-variant-numeric: tabular-nums;
}
.list-loading {
  padding: 10px;
}
.skeleton-row,
.skeleton {
  display: block;
  background: linear-gradient(90deg, var(--code-bg), var(--hover), var(--code-bg));
  background-size: 200% 100%;
  animation: shimmer 1.4s infinite linear;
}
.skeleton-row {
  height: 82px;
  margin-bottom: 8px;
  border-radius: 10px;
}
.empty-list {
  display: grid;
  place-items: center;
  padding: 72px 28px;
  color: var(--muted);
  text-align: center;
}
.empty-list > span {
  margin-bottom: 12px;
  font: 36px/1 Georgia, serif;
  color: var(--faint);
}
.empty-list strong {
  color: var(--fg);
  font: 600 16px/1.3 'Iowan Old Style', Georgia, serif;
}
.empty-list p {
  max-width: 24ch;
  margin: 7px 0 0;
  font-size: 12px;
  line-height: 1.5;
}
.detail {
  flex: 1;
  overflow-y: auto;
  padding: clamp(34px, 6vw, 86px) clamp(28px, 7vw, 110px) 96px;
  min-width: 0;
  scroll-behavior: smooth;
  background:
    radial-gradient(circle at 92% 8%, color-mix(in srgb, var(--accent) 7%, transparent), transparent 28rem),
    var(--surface-strong);
}
.placeholder {
  max-width: 540px;
  margin: clamp(60px, 14vh, 150px) auto 0;
  text-align: left;
}
.placeholder-mark {
  width: 52px;
  height: 52px;
  margin-bottom: 28px;
  font-size: 23px;
}
.placeholder h2,
.note-header h2 {
  margin: 0;
  font-family: 'Iowan Old Style', 'Palatino Linotype', Georgia, serif;
  font-size: clamp(36px, 5vw, 64px);
  font-weight: 500;
  line-height: 1.02;
  letter-spacing: -0.045em;
  text-wrap: balance;
}
.placeholder > p:last-child {
  max-width: 50ch;
  margin: 22px 0 0;
  color: var(--muted);
  font-size: 15px;
  line-height: 1.7;
}
.eyebrow {
  margin: 0 0 14px;
  color: var(--accent);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.13em;
  text-transform: uppercase;
}
.note,
.article-loading {
  width: min(100%, 780px);
  margin: 0 auto;
}
.note-header {
  margin-bottom: 44px;
  padding-bottom: 28px;
  border-bottom: 1px solid var(--border);
}
.note-header .eyebrow {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 7px 10px;
  align-items: center;
  margin-top: 22px;
}
.type,
.tag {
  font-size: 10px;
  font-weight: 600;
  padding: 4px 8px;
  border-radius: 5px;
  background: var(--tag-bg);
  color: var(--badge-fg);
}
.sources {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  font-size: 11px;
  color: var(--muted);
  margin-top: 18px;
}
.sources strong {
  margin-right: 2px;
  color: var(--fg);
}
.src {
  background: var(--hover);
  border: 0;
  border-radius: 5px;
  padding: 3px 7px;
  display: inline-block;
  color: var(--fg);
  text-decoration: none;
  transition: color 0.2s, background-color 0.2s;
}
a.src:hover {
  color: var(--link);
  background: var(--active);
  text-decoration: none;
}
.content {
  max-width: 70ch;
  line-height: 1.78;
  font-size: 16px;
}
.content h1,
.content h2,
.content h3 {
  margin: 1.8em 0 0.65em;
  font-family: 'Iowan Old Style', 'Palatino Linotype', Georgia, serif;
  font-weight: 600;
  line-height: 1.15;
  letter-spacing: -0.025em;
  text-wrap: balance;
}
.content h2 {
  font-size: 27px;
}
.content h3 {
  font-size: 21px;
}
.content p {
  text-wrap: pretty;
}
.content img {
  max-width: 100%;
  height: auto;
  border-radius: 10px;
}
.content code {
  background: var(--code-bg);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 13px;
}
.content pre {
  background: var(--code-bg);
  padding: 18px;
  border: 1px solid var(--border-soft);
  border-radius: 10px;
  overflow-x: auto;
}
.content pre code {
  background: none;
  padding: 0;
}
.content table {
  border-collapse: collapse;
  margin: 20px 0;
  display: block;
  max-width: 100%;
  overflow-x: auto; /* wide tables scroll inside instead of widening the page */
}
.content th,
.content td {
  border: 1px solid var(--border);
  padding: 9px 13px;
  font-size: 14px;
}
.content th {
  background: var(--code-bg);
}
.content blockquote {
  margin: 24px 0;
  padding: 2px 0 2px 22px;
  border-left: 2px solid var(--accent);
  color: var(--blockquote-fg);
  font-family: 'Iowan Old Style', Georgia, serif;
  font-size: 18px;
}
.content a {
  color: var(--link);
  text-decoration: none;
}
.content a:hover {
  text-decoration: underline;
}
.article-loading {
  padding-top: 12px;
}
.article-loading .skeleton {
  border-radius: 7px;
}
.eyebrow-skeleton {
  width: 28%;
  height: 10px;
  margin-bottom: 24px;
}
.title-skeleton {
  width: 76%;
  height: 58px;
  margin-bottom: 22px;
}
.meta-skeleton {
  width: 38%;
  height: 22px;
  margin-bottom: 64px;
}
.copy-skeleton {
  height: 13px;
  margin-bottom: 15px;
}
@keyframes shimmer {
  to { background-position: -200% 0; }
}
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    scroll-behavior: auto !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
@media (max-width: 760px) {
  .topbar {
    gap: 8px;
    padding: 11px 14px 12px;
    min-height: auto;
    flex-wrap: wrap;
  }
  .controls {
    display: grid;
    grid-template-columns: 1fr auto auto;
    gap: 8px;
    width: 100%;
  }
  .search-wrap {
    width: 100%;
  }
  .search-wrap kbd {
    display: none;
  }
  .nav-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 38px;
    height: 38px;
    margin-right: 10px;
    border: 1px solid var(--border);
    border-radius: 11px;
    background: var(--surface-strong);
    color: var(--fg);
    padding: 0;
    cursor: pointer;
  }
  .brand-mark {
    width: 36px;
    height: 36px;
  }
  .brand h1 {
    font-size: 19px;
  }
  .sub {
    font-size: 10px;
  }
  .list {
    position: fixed;
    top: 0;
    bottom: 0;
    left: 0;
    width: min(88vw, 350px);
    max-height: none;
    border-right: 1px solid var(--border);
    border-bottom: none;
    box-shadow: 14px 0 40px var(--shadow);
    z-index: 40;
    transform: translateX(-105%);
    transition: transform 0.18s ease;
    background: var(--surface);
  }
  .list.open {
    transform: none;
  }
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 30;
  }
  .detail {
    padding: 44px 22px 72px;
  }
  .placeholder {
    margin-top: 48px;
  }
  .placeholder h2,
  .note-header h2 {
    font-size: clamp(34px, 11vw, 48px);
  }
  .note-header {
    margin-bottom: 34px;
  }
  .content {
    font-size: 15px;
  }
}
@media (max-width: 420px) {
  .toggle > span:last-child {
    display: none;
  }
  .controls {
    grid-template-columns: 1fr 30px 38px;
  }
  .toggle {
    justify-content: center;
  }
}
</style>
