export interface AssemblyContext { label: string; description: string }

// Use the verified partition's source, never infer scope from a small bin size.
export function assemblyContext(html: string): AssemblyContext | null {
  const match = html.match(/<script\b[^>]*\bid=["']bin-partition-data["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return null;
  let data: unknown;
  try { data = JSON.parse(match[1]); } catch { return null; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const source = (data as { source?: unknown }).source;
  if (source === 'final/assembly/consolidated_contigs.fasta' || source === 'final/assembly/contigs.fasta') {
    return { label: 'Retained assembly', description: 'After filtering and any accepted reassembly. Removed host and other excluded contigs are not shown.' };
  }
  if (source === 'megahit/final.contigs.fa' || source === 'assembly/preliminary_contigs.fasta') {
    return { label: 'Initial assembly', description: 'Before taxonomic filtering. Each bin size describes only the contigs assigned to that bin.' };
  }
  return { label: 'Displayed assembly', description: 'Sizes describe the displayed contigs; the initial assembly total is not established by this report.' };
}

export function assemblyNote(html: string, context: AssemblyContext | null): string {
  if (!context || /\bid=["']assembly-scope-note["']/i.test(html)) return html;
  // Both strings are fixed labels above; no report-controlled markup is inserted.
  const note = `<p id="assembly-scope-note" class="assembly-scope-note"><strong>${context.label}</strong> · ${context.description}</p>`;
  return html.replace(/(<div\b[^>]*\bid=["']pane-bins["'][^>]*>)/i, (pane) => pane + note);
}
