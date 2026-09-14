// Kareenos Browser Channel v2 — pure formatter for browser_snapshot output.
// No chrome APIs: unit-tested in isolation.
//
// Shape the agent reads:
//   # snapshot url=… title="…" viewport=1280x720 scroll=0/5400 frames=3 refs=142 mode=interactive chars=8123/30000
//   !! dialog open: "Create a post" [f3e1] modal
//   * focus: [f3e7] textbox "Text editor for creating content"
//   ## f3 child-of=f0 url=… dialog
//   - dialog "Create a post" [f3e1] modal
//     - textbox "Text editor…" [f3e7] *focused* editable value=""
//   ## f0 top url=https://…
//   - navigation "Primary"
//     - link "Home" [f0e3] href="/feed/"
//     … +214 lines omitted (pass selector/scope or raise max_chars)
//   (2 empty/ad frames skipped: f5, f6)

export interface FrameSnapshot {
  frameId: number;
  parentFrameId: number;
  url: string;
  title?: string;
  lines: string[]; // already ref-rewritten (f<id>e<n>) and indented
  refs: number;
  truncated: boolean;
  dialogs: Array<{ ref: string; name: string; modal: boolean }>; // refs rewritten
  focus: { ref: string; role: string; name: string; is_iframe?: boolean } | null; // ref rewritten
  viewport?: { w: number; h: number; scrollX: number; scrollY: number; scrollW: number; scrollH: number };
  error?: { code: string; message: string };
}

export interface FormatOptions {
  url: string;
  title: string;
  frames: FrameSnapshot[];
  maxChars: number;
  mode: string;
}

export interface FormattedSnapshot {
  text: string;
  chars: number;
  truncated: boolean;
  frames_included: number[];
  frames_skipped: number[];
  frames_inaccessible: number[];
  refs: number;
}

const OMITTED = (n: number) => `  … +${n} lines omitted (pass selector/scope or raise max_chars)`;
const FRAME_FLOOR = 1500;

function q(s: string): string {
  return '"' + String(s || '').replace(/"/g, '\\"') + '"';
}

export function formatSnapshot(o: FormatOptions): FormattedSnapshot {
  const maxChars = Math.max(500, Math.floor(o.maxChars || 30000));
  const frames = o.frames.slice();
  const inaccessible = frames.filter((f) => f.error).map((f) => f.frameId);
  const usable = frames.filter((f) => !f.error);
  const skipped = usable.filter((f) => !f.lines.length).map((f) => f.frameId);
  const content = usable.filter((f) => f.lines.length);

  // Order: frames that own an open dialog first, then top, then by size.
  content.sort((a, b) => {
    const ad = a.dialogs.length ? 1 : 0;
    const bd = b.dialogs.length ? 1 : 0;
    if (ad !== bd) return bd - ad;
    if (a.frameId === 0) return -1;
    if (b.frameId === 0) return 1;
    return b.lines.length - a.lines.length;
  });

  const refsTotal = usable.reduce((n, f) => n + (f.refs || 0), 0);
  const top = usable.find((f) => f.frameId === 0) || usable[0];
  const vp = top && top.viewport;
  const headerBase =
    `# snapshot url=${o.url || ''} title=${q(o.title || '')}` +
    (vp ? ` viewport=${vp.w}x${vp.h} scroll=${vp.scrollY}/${vp.scrollH}` : '') +
    ` frames=${frames.length} refs=${refsTotal} mode=${o.mode}`;

  const alerts: string[] = [];
  let dialogsListed = 0;
  content.forEach((f) => {
    f.dialogs.forEach((d) => {
      if (dialogsListed >= 3) return;
      alerts.push(`!! dialog open: ${q(d.name || 'dialog')} [${d.ref}]${d.modal ? ' modal' : ''} (frame f${f.frameId})`);
      dialogsListed++;
    });
  });
  // Deepest non-iframe focus owner.
  let focusLine = '';
  let focusFrame = -1;
  usable.forEach((f) => {
    if (f.focus && !f.focus.is_iframe && f.frameId > focusFrame) {
      focusFrame = f.frameId;
      focusLine = `* focus: [${f.focus.ref}] ${f.focus.role} ${q(f.focus.name || '')}`;
    }
  });
  if (focusLine) alerts.push(focusLine);

  const tail: string[] = [];
  if (skipped.length) tail.push(`(${skipped.length} empty/ad frame${skipped.length > 1 ? 's' : ''} skipped: ${skipped.map((n) => 'f' + n).join(', ')})`);
  inaccessible.forEach((id) => {
    const f = frames.find((x) => x.frameId === id)!;
    tail.push(`(frame f${id} not accessible: ${f.error!.code}${f.url ? ' ' + f.url : ''})`);
  });

  // Budget: header + alerts + tail are fixed; frames share the rest. Every frame
  // block reserves room for its own omitted-marker line so the hard cut below
  // stays a backstop that (almost) never fires.
  const MARKER_RESERVE = 90;
  const fixed =
    headerBase.length + 30 + alerts.join('\n').length + tail.join('\n').length + (alerts.length + tail.length + 2) + 40;
  let remaining = Math.max(200, maxChars - fixed);

  const blocks: string[] = [];
  const included: number[] = [];
  let truncated = false;

  const frameHeader = (f: FrameSnapshot) =>
    `## f${f.frameId} ${f.frameId === 0 ? 'top' : 'child-of=f' + f.parentFrameId}${f.url ? ' url=' + f.url : ''}${f.dialogs.length ? ' dialog' : ''}`;
  const sizeOf = (f: FrameSnapshot) => frameHeader(f).length + 1 + f.lines.reduce((n, l) => n + l.length + 1, 0);

  const total = content.reduce((n, f) => n + sizeOf(f), 0);
  const budgets = new Map<number, number>();
  if (total <= remaining) {
    content.forEach((f) => budgets.set(f.frameId, sizeOf(f)));
  } else {
    // floors first (the smaller of FRAME_FLOOR and the frame's own size)
    let floorSum = 0;
    content.forEach((f) => {
      const fl = Math.min(FRAME_FLOOR, sizeOf(f));
      budgets.set(f.frameId, fl);
      floorSum += fl;
    });
    let left = remaining - floorSum;
    if (left < 0) {
      // even the floors do not fit: scale floors down proportionally
      const scale = remaining / Math.max(1, floorSum);
      content.forEach((f) => budgets.set(f.frameId, Math.floor(budgets.get(f.frameId)! * scale)));
      left = 0;
    }
    if (left > 0) {
      const extraTotal = content.reduce((n, f) => n + Math.max(0, sizeOf(f) - budgets.get(f.frameId)!), 0);
      if (extraTotal > 0) {
        content.forEach((f) => {
          const extra = Math.max(0, sizeOf(f) - budgets.get(f.frameId)!);
          budgets.set(f.frameId, budgets.get(f.frameId)! + Math.floor((left * extra) / extraTotal));
        });
      }
    }
  }

  content.forEach((f) => {
    const budget = budgets.get(f.frameId) || 0;
    const head = frameHeader(f);
    const lines: string[] = [head];
    let used = head.length + 1;
    let omitted = 0;
    const cutAt = budget >= sizeOf(f) ? Infinity : Math.max(head.length + 2, budget - MARKER_RESERVE);
    for (let i = 0; i < f.lines.length; i++) {
      const l = f.lines[i];
      if (used + l.length + 1 > cutAt && i > 0) {
        omitted = f.lines.length - i;
        break;
      }
      lines.push(l);
      used += l.length + 1;
    }
    if (omitted > 0 || f.truncated) {
      lines.push(OMITTED(omitted + (f.truncated ? 1 : 0)));
      truncated = true;
    }
    blocks.push(lines.join('\n'));
    included.push(f.frameId);
    remaining -= used;
  });

  const body = [...alerts, ...blocks, ...tail].join('\n');
  let text = headerBase + ' chars=%CHARS%/' + maxChars + '\n' + body;
  // resolve the chars placeholder (length of the final text)
  const approx = text.replace('%CHARS%', '00000').length;
  text = text.replace('%CHARS%', String(approx));
  if (text.length > maxChars) {
    text = text.slice(0, maxChars - 60) + '\n… (snapshot hard-cut at max_chars)';
    truncated = true;
  }
  return {
    text,
    chars: text.length,
    truncated,
    frames_included: included,
    frames_skipped: skipped,
    frames_inaccessible: inaccessible,
    refs: refsTotal,
  };
}
