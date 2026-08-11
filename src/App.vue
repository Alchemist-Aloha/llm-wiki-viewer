<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
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

const pages = ref<PageMeta[]>([])
const query = ref('')
const onlyWiki = ref(false)
const detail = ref<PageDetail | null>(null)
const error = ref('')
const basenameToSlug = new Map<string, string>()

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  return pages.value.filter((p) => {
    if (onlyWiki.value && !p.wikiManaged) return false
    if (!q) return true
    return (p.title + ' ' + p.tags.join(' ') + ' ' + p.excerpt).toLowerCase().includes(q)
  })
})

onMounted(async () => {
  try {
    const res = await fetch('/api/pages')
    pages.value = (await res.json()).pages
    for (const p of pages.value) {
      const base = p.slug.split('/').pop()!
      if (!basenameToSlug.has(base)) basenameToSlug.set(base, p.slug)
    }
  } catch (e) {
    error.value = String(e)
  }
})

async function open(slug: string) {
  try {
    const res = await fetch('/api/page/' + slug)
    if (!res.ok) return
    detail.value = await res.json()
  } catch (e) {
    error.value = String(e)
  }
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
  e.preventDefault()
  const target = decodeURIComponent(m[1])
  const slug = pages.value.some((p) => p.slug === target)
    ? target
    : basenameToSlug.get(target)
  if (slug) open(slug)
}
</script>

<template>
  <div class="app">
    <header class="topbar">
      <div class="brand">
        <span class="dot"></span>
        <h1>LLM Wiki</h1>
        <span class="sub">{{ pages.length }} notes</span>
      </div>
      <div class="controls">
        <input v-model="query" class="search" type="search" placeholder="Search title, tags, content…" />
        <label class="toggle">
          <input v-model="onlyWiki" type="checkbox" />
          <span>llm_wiki only</span>
        </label>
      </div>
    </header>

    <p v-if="error" class="error">{{ error }}</p>

    <main class="main">
      <aside class="list">
        <div class="count">{{ filtered.length }} / {{ pages.length }}</div>
        <ul>
          <li
            v-for="p in filtered"
            :key="p.slug"
            :class="{ active: detail?.slug === p.slug }"
            @click="open(p.slug)"
          >
            <div class="row1">
              <span class="badge" :class="p.layer">{{ p.layer }}</span>
              <span class="date">{{ (p.updated || '').slice(0, 10) }}</span>
            </div>
            <div class="title">{{ p.title }}</div>
            <div class="excerpt">{{ p.excerpt }}</div>
          </li>
        </ul>
      </aside>

      <section class="detail" @click="onLink">
        <div v-if="!detail" class="placeholder">Select a note…</div>
        <template v-else>
          <h2>{{ detail.frontmatter.title }}</h2>
          <div class="meta">
            <span v-if="detail.frontmatter.type" class="type">{{ detail.frontmatter.type }}</span>
            <span v-for="t in detail.frontmatter.tags" :key="t" class="tag">{{ t }}</span>
            <span v-if="detail.frontmatter.updated" class="date">updated {{ detail.frontmatter.updated }}</span>
          </div>
          <p v-if="detail.frontmatter.sources.length" class="sources">
            Sources:
            <span v-for="s in detail.frontmatter.sources" :key="s" class="src">{{ s }}</span>
          </p>
          <article class="content" v-html="rendered"></article>
        </template>
      </section>
    </main>
  </div>
</template>

<style>
* {
  box-sizing: border-box;
}
html,
body,
#app {
  height: 100%;
  margin: 0;
}
body {
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
  color: #1f2328;
  background: #fff;
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
  gap: 16px;
  padding: 10px 20px;
  border-bottom: 1px solid #e5e7eb;
  background: #fafbfc;
  flex-wrap: wrap;
}
.brand {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.brand h1 {
  font-size: 18px;
  margin: 0;
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #4f7cff;
  align-self: center;
}
.sub {
  color: #6b7280;
  font-size: 13px;
}
.controls {
  display: flex;
  align-items: center;
  gap: 14px;
}
.search {
  padding: 6px 12px;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  font-size: 14px;
  width: 260px;
}
.toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}
.error {
  margin: 8px 20px;
  color: #b91c1c;
}
.main {
  flex: 1;
  display: flex;
  min-height: 0;
}
.list {
  width: 340px;
  border-right: 1px solid #e5e7eb;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
.count {
  padding: 8px 14px;
  font-size: 12px;
  color: #6b7280;
  border-bottom: 1px solid #f0f0f0;
  position: sticky;
  top: 0;
  background: #fff;
}
.list ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
.list li {
  padding: 10px 14px;
  border-bottom: 1px solid #f3f4f6;
  cursor: pointer;
}
.list li:hover {
  background: #f6f8fa;
}
.list li.active {
  background: #eef3ff;
  border-left: 3px solid #4f7cff;
}
.row1 {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}
.badge {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  background: #e5e7eb;
  color: #374151;
}
.badge.entities,
.badge.concepts,
.badge.comparisons,
.badge.queries {
  background: #dbeafe;
  color: #1d4ed8;
}
.badge.raw {
  background: #fef3c7;
  color: #92400e;
}
.title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.excerpt {
  font-size: 12px;
  color: #6b7280;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.date {
  font-size: 12px;
  color: #9ca3af;
}
.detail {
  flex: 1;
  overflow-y: auto;
  padding: 24px 32px;
  min-width: 0;
}
.placeholder {
  color: #9ca3af;
  font-size: 15px;
  text-align: center;
  margin-top: 20vh;
}
.detail h2 {
  margin: 0 0 10px;
  font-size: 24px;
}
.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
}
.type,
.tag {
  font-size: 12px;
  padding: 2px 10px;
  border-radius: 999px;
  background: #f3f4f6;
  color: #374151;
}
.sources {
  font-size: 12px;
  color: #6b7280;
  margin: 4px 0 12px;
}
.src {
  background: #f6f8fa;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  padding: 1px 6px;
  margin-right: 4px;
  display: inline-block;
}
.content {
  line-height: 1.65;
  font-size: 15px;
  max-width: 860px;
}
.content h1,
.content h2,
.content h3 {
  margin-top: 1.4em;
  line-height: 1.3;
}
.content h2 {
  border-bottom: 1px solid #eee;
  padding-bottom: 6px;
}
.content code {
  background: #f3f4f6;
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 13px;
}
.content pre {
  background: #f6f8fa;
  padding: 12px;
  border-radius: 8px;
  overflow-x: auto;
}
.content pre code {
  background: none;
  padding: 0;
}
.content table {
  border-collapse: collapse;
  margin: 12px 0;
}
.content th,
.content td {
  border: 1px solid #d1d5db;
  padding: 6px 12px;
  font-size: 14px;
}
.content th {
  background: #f6f8fa;
}
.content blockquote {
  margin: 12px 0;
  padding: 4px 16px;
  border-left: 3px solid #d1d5db;
  color: #4b5563;
}
.content a {
  color: #2563eb;
  text-decoration: none;
}
.content a:hover {
  text-decoration: underline;
}
@media (max-width: 760px) {
  .main {
    flex-direction: column;
  }
  .list {
    width: 100%;
    max-height: 40vh;
    border-right: none;
    border-bottom: 1px solid #e5e7eb;
  }
  .detail {
    padding: 16px;
  }
}
</style>
