import { useEffect, useState } from "react";
import { Columns2, Loader2, SplitSquareHorizontal } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import type { BlobData, BlobSpec } from "../lib/types";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|svg|avif)$/i;
export const isImagePath = (p: string) => IMAGE_EXT.test(p);

export interface ImageSides {
  old: BlobSpec | null;
  new: BlobSpec | null;
}

interface Loaded {
  url: string;
  size: number;
  w?: number;
  h?: number;
}

function fmtSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function useBlob(root: string, spec: BlobSpec | null) {
  const [state, setState] = useState<{ data: Loaded | null; loading: boolean; error: string | null }>({ data: null, loading: !!spec, error: null });
  const key = spec ? JSON.stringify(spec) : "";
  useEffect(() => {
    if (!spec) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    let alive = true;
    setState({ data: null, loading: true, error: null });
    api.blob(root, spec).then(
      (b: BlobData | null) => {
        if (!alive) return;
        if (!b) return setState({ data: null, loading: false, error: null });
        const url = `data:${b.mime};base64,${b.base64}`;
        const img = new Image();
        img.onload = () => alive && setState({ data: { url, size: b.size, w: img.naturalWidth, h: img.naturalHeight }, loading: false, error: null });
        img.onerror = () => alive && setState({ data: { url, size: b.size }, loading: false, error: "Cannot decode this image" });
        img.src = url;
      },
      (e) => alive && setState({ data: null, loading: false, error: errorMessage(e) }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, key]);
  return state;
}

const checker: React.CSSProperties = {
  backgroundColor: "var(--bg-elev)",
  backgroundImage:
    "linear-gradient(45deg, var(--bg-hover-strong) 25%, transparent 25%), linear-gradient(-45deg, var(--bg-hover-strong) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--bg-hover-strong) 75%), linear-gradient(-45deg, transparent 75%, var(--bg-hover-strong) 75%)",
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0",
};

function Side({ label, tone, state }: { label: string; tone: string; state: ReturnType<typeof useBlob> }) {
  return (
    <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }}>
      <div className="hstack" style={{ gap: 8 }}>
        <span className={`pill ${tone}`}>{label}</span>
        {state.data && (
          <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
            {state.data.w ? `${state.data.w} × ${state.data.h} px · ` : ""}
            {fmtSize(state.data.size)}
          </span>
        )}
      </div>
      <div style={{ ...checker, flex: 1, minHeight: 200, borderRadius: 10, border: "1px solid var(--border)", display: "grid", placeItems: "center", padding: 12, overflow: "hidden" }}>
        {state.loading ? (
          <Loader2 className="spin faint" />
        ) : state.data ? (
          <img src={state.data.url} alt={label} style={{ maxWidth: "100%", maxHeight: "60vh", objectFit: "contain", imageRendering: "auto" }} />
        ) : (
          <span className="faint">{state.error ?? "No image"}</span>
        )}
      </div>
    </div>
  );
}

export function ImageDiff({ root, sides }: { root: string; sides: ImageSides }) {
  const before = useBlob(root, sides.old);
  const after = useBlob(root, sides.new);
  const [mode, setMode] = useState<"side" | "swipe">("side");
  const [pos, setPos] = useState(50);
  const both = !!before.data && !!after.data;
  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12, fontFamily: "var(--font-ui)", height: "100%" }}>
      {both && (
        <div className="seg" style={{ alignSelf: "flex-start" }}>
          <button className={mode === "side" ? "on" : ""} onClick={() => setMode("side")}>
            <Columns2 size={13} /> Side by side
          </button>
          <button className={mode === "swipe" ? "on" : ""} onClick={() => setMode("swipe")}>
            <SplitSquareHorizontal size={13} /> Swipe
          </button>
        </div>
      )}
      {mode === "swipe" && both ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: 1 }}>
          <div style={{ ...checker, position: "relative", flex: 1, minHeight: 260, borderRadius: 10, border: "1px solid var(--border)", overflow: "hidden", display: "grid", placeItems: "center" }}>
            <img src={before.data!.url} alt="before" style={{ maxWidth: "100%", maxHeight: "60vh", objectFit: "contain", gridArea: "1 / 1" }} />
            <img
              src={after.data!.url}
              alt="after"
              style={{ maxWidth: "100%", maxHeight: "60vh", objectFit: "contain", gridArea: "1 / 1", clipPath: `inset(0 0 0 ${pos}%)` }}
            />
            <div style={{ position: "absolute", top: 0, bottom: 0, left: `${pos}%`, width: 2, background: "var(--accent)", boxShadow: "0 0 8px var(--accent)" }} />
          </div>
          <div className="hstack">
            <span className="pill red">Before</span>
            <input type="range" min={0} max={100} value={pos} onChange={(e) => setPos(Number(e.target.value))} style={{ flex: 1, accentColor: "var(--accent)" }} />
            <span className="pill green">After</span>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 16, flex: 1, minHeight: 0 }}>
          {sides.old && <Side label="Before" tone="red" state={before} />}
          {sides.new && <Side label="After" tone="green" state={after} />}
        </div>
      )}
    </div>
  );
}
