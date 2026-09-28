/**
 * Every row of a paged list, for a download: asks page after page until a
 * short page comes back. Capped so a mistaken filter cannot run forever.
 */
export async function allPages<T>(fetchPage: (limit: number, offset: number) => Promise<T[]>, pageSize: number, maxRows = 50_000): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const page = await fetchPage(pageSize, offset);
    out.push(...page);
    if (page.length < pageSize) break;
  }
  return out;
}
