/**
 * The user and partner guide, at /docs.
 *
 * The guide's single source is the Markdown in docs/guide/ at the root of the
 * repository (which GitHub also displays). It is bundled here at build time, so
 * the guide inside the system always matches the version that is running.
 * Readable without signing in: it is shown to prospective clients and partners,
 * and holds no business data (screenshots come from a fictional demo business).
 */

import { marked, type Tokens } from 'marked';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';

import './docs.css';

const RAW = import.meta.glob('../../../../docs/guide/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const IMAGES = import.meta.glob('../../../../docs/guide/images/*.{jpg,png}', { query: '?url', import: 'default', eager: true }) as Record<string, string>;

interface Chapter {
  slug: string;
  title: string;
  markdown: string;
}

const fileSlug = (path: string): string => path.split('/').pop()!.replace(/\.md$/, '');

const CHAPTERS: Chapter[] = Object.entries(RAW)
  .map(([path, markdown]) => {
    const slug = fileSlug(path) === 'README' ? '' : fileSlug(path);
    const title = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? slug;
    return { slug, title, markdown };
  })
  .sort((a, b) => (a.slug === '' ? -1 : b.slug === '' ? 1 : a.slug.localeCompare(b.slug)));

const imageUrl = (src: string): string => {
  const name = src.replace(/^\.?\/?images\//, '');
  const hit = Object.entries(IMAGES).find(([p]) => p.endsWith(`/images/${name}`));
  return hit?.[1] ?? src;
};

/** GitHub-style heading ids, so #links written for GitHub work here too. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

function render(markdown: string): { html: string; headings: { id: string; text: string }[] } {
  const headings: { id: string; text: string }[] = [];
  const seen = new Map<string, number>();
  const renderer = new marked.Renderer();
  renderer.heading = function ({ tokens, depth }: Tokens.Heading) {
    const text = this.parser.parseInline(tokens);
    const plain = text.replace(/<[^>]+>/g, '');
    let id = slugify(plain);
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    if (n > 0) id = `${id}-${n}`;
    if (depth === 2) headings.push({ id, text: plain });
    return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${text}</h${depth}>`;
  };
  renderer.link = function ({ href, title, tokens }: Tokens.Link) {
    const text = this.parser.parseInline(tokens);
    let to = href;
    const md = /^(\d\d-[a-z0-9-]+|README)\.md(#.*)?$/.exec(href);
    if (md !== null) to = `/docs/${md[1] === 'README' ? '' : md[1]}${md[2] ?? ''}`;
    else if (href.startsWith('#')) to = href;
    const external = /^https?:/.test(to);
    return `<a href="${to}"${title ? ` title="${title}"` : ''}${external ? ' target="_blank" rel="noopener"' : ''} data-internal="${!external && !to.startsWith('#')}">${text}</a>`;
  };
  renderer.image = function ({ href, title, text }: Tokens.Image) {
    return `<figure><img src="${imageUrl(href)}" alt="${text}" loading="lazy"${title ? ` title="${title}"` : ''} /><figcaption>${text}</figcaption></figure>`;
  };
  renderer.table = function (token: Tokens.Table) {
    const head = token.header.map((c) => `<th${c.align ? ` style="text-align:${c.align}"` : ''}>${this.parser.parseInline(c.tokens)}</th>`).join('');
    const body = token.rows
      .map((r) => `<tr>${r.map((c) => `<td${c.align ? ` style="text-align:${c.align}"` : ''}>${this.parser.parseInline(c.tokens)}</td>`).join('')}</tr>`)
      .join('');
    return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  };
  const html = marked.parse(markdown, { renderer, gfm: true, async: false }) as string;
  return { html, headings };
}

export function Docs() {
  const { slug = '' } = useParams();
  const nav = useNavigate();
  const location = useLocation();
  const [query, setQuery] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const body = useRef<HTMLDivElement>(null);

  const chapter = CHAPTERS.find((c) => c.slug === slug) ?? CHAPTERS[0]!;
  const { html, headings } = useMemo(() => render(chapter.markdown), [chapter]);
  const index = CHAPTERS.indexOf(chapter);
  const prev = index > 0 ? CHAPTERS[index - 1] : undefined;
  const next = index < CHAPTERS.length - 1 ? CHAPTERS[index + 1] : undefined;

  const q = query.trim().toLowerCase();
  const matches = q === '' ? [] : CHAPTERS.filter((c) => c.markdown.toLowerCase().includes(q)).map((c) => {
    const at = c.markdown.toLowerCase().indexOf(q);
    const snippet = c.markdown.slice(Math.max(0, at - 50), at + q.length + 70).replace(/[#*|`>_]/g, ' ').replace(/\s+/g, ' ');
    return { c, snippet };
  });

  useEffect(() => {
    document.title = `${chapter.title} · Retail Operations Platform guide`;
    if (location.hash !== '') document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
    else window.scrollTo(0, 0);
    setMenuOpen(false);
  }, [chapter, location.hash]);

  // Links inside the guide stay inside the app, without a full page load.
  function onClick(e: React.MouseEvent) {
    const a = (e.target as HTMLElement).closest('a');
    if (a?.dataset['internal'] === 'true') {
      e.preventDefault();
      nav(a.getAttribute('href')!);
    }
  }

  const toc = (
    <nav aria-label="Guide chapters" className="space-y-0.5">
      {CHAPTERS.map((c) => (
        <Link
          key={c.slug}
          to={`/docs/${c.slug}`}
          className={`block rounded-md px-2.5 py-1.5 text-[13px] leading-snug ${
            c === chapter ? 'bg-accent-50 text-accent-700 font-semibold' : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900'
          }`}
        >
          {c.slug === '' ? 'Welcome' : c.title}
        </Link>
      ))}
    </nav>
  );

  return (
    <div className="bg-ink-50 min-h-screen">
      <header className="border-ink-200 sticky top-0 z-20 border-b bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-2.5">
          <button className="text-ink-600 lg:hidden" onClick={() => setMenuOpen((v) => !v)} aria-label="Chapters">
            ☰
          </button>
          <Link to="/docs" className="flex items-center gap-2">
            <span className="bg-accent-600 grid size-7 place-items-center rounded-lg text-[13px] font-bold text-white">R</span>
            <span className="text-[14px] font-semibold tracking-tight">
              Retail Operations <span className="text-ink-400 font-normal">· Guide</span>
            </span>
          </Link>
          <div className="relative ml-auto w-full max-w-xs">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search the guide…"
              aria-label="Search the guide"
              className="border-ink-200 focus:border-accent-500 w-full rounded-lg border bg-white px-3 py-1.5 text-[13px] outline-none"
            />
            {q !== '' && (
              <div className="border-ink-200 absolute right-0 z-30 mt-1 max-h-96 w-[min(28rem,90vw)] overflow-y-auto rounded-lg border bg-white shadow-lg" data-testid="doc-search">
                {matches.length === 0 ? (
                  <p className="text-ink-400 px-3 py-3 text-[12.5px]">Nothing found for “{query}”.</p>
                ) : (
                  matches.map(({ c, snippet }) => (
                    <button
                      key={c.slug}
                      onClick={() => {
                        setQuery('');
                        nav(`/docs/${c.slug}`);
                      }}
                      className="hover:bg-ink-50 block w-full px-3 py-2 text-left"
                    >
                      <div className="text-[13px] font-medium">{c.slug === '' ? 'Welcome' : c.title}</div>
                      <div className="text-ink-500 truncate text-[12px]">…{snippet}…</div>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
          <a href="/" className="bg-accent-600 hover:bg-accent-700 hidden shrink-0 rounded-lg px-3 py-1.5 text-[12.5px] font-medium text-white sm:inline-block">
            Open the system
          </a>
        </div>
      </header>

      <div className="mx-auto flex max-w-7xl gap-8 px-4 py-6">
        <aside className="hidden w-60 shrink-0 lg:block">
          <div className="sticky top-20">{toc}</div>
        </aside>
        {menuOpen && (
          <div className="fixed inset-0 z-30 bg-black/30 lg:hidden" onClick={() => setMenuOpen(false)}>
            <div className="h-full w-72 overflow-y-auto bg-white p-3 shadow-xl" onClick={(e) => e.stopPropagation()}>
              {toc}
            </div>
          </div>
        )}

        <main className="min-w-0 flex-1">
          <article className="doc-content rounded-xl bg-white px-5 py-6 shadow-sm ring-1 ring-black/5 sm:px-10 sm:py-9" ref={body} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} data-testid="doc-body" />
          <div className="mt-4 flex justify-between gap-3 text-[13px]">
            {prev !== undefined ? (
              <Link to={`/docs/${prev.slug}`} className="text-ink-600 hover:text-accent-700">
                ← {prev.slug === '' ? 'Welcome' : prev.title}
              </Link>
            ) : (
              <span />
            )}
            {next !== undefined && (
              <Link to={`/docs/${next.slug}`} className="text-ink-600 hover:text-accent-700 text-right">
                {next.title} →
              </Link>
            )}
          </div>
        </main>

        {headings.length > 2 && (
          <aside className="hidden w-52 shrink-0 xl:block">
            <div className="sticky top-20">
              <div className="text-ink-400 mb-2 text-[11px] font-medium uppercase tracking-wider">On this page</div>
              <nav className="space-y-1">
                {headings.map((h) => (
                  <a key={h.id} href={`#${h.id}`} className="text-ink-500 hover:text-accent-700 block text-[12.5px] leading-snug">
                    {h.text}
                  </a>
                ))}
              </nav>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
