import { IInputs, IOutputs } from "./generated/ManifestTypes";

interface MatRow {
  id: string;
  cp_matlabel?: string | null;
  cp_matnumber?: number | null;
  cp_matwidth?: number | null;
  cp_matheight?: number | null;
  cp_xposition?: number | null;
  cp_yposition?: number | null;
  cp_fillcolor?: string | null;
  cp_strokecolor?: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
}

export class MatsOverlay implements ComponentFramework.StandardControl<IInputs, IOutputs> {
  private container!: HTMLDivElement;
  private context!: ComponentFramework.Context<IInputs>;
  private notifyOutputChanged!: () => void;

// Output state
private selectedId = "";
private changeKind = "";
private newX = 0;
private newY = 0;
private newW = 0;
private newH = 0;

// Drag state
private dragging = false;
private dragMatId = "";
private dragOffsetX = 0;
private dragOffsetY = 0;
private dragStartX = 0;
private dragStartY = 0;
private currentMats: MatRow[] = [];
private scale = 1;
private offsetX = 0;
private offsetY = 0;

  public init(
    context: ComponentFramework.Context<IInputs>,
    notifyOutputChanged: () => void,
    _state: ComponentFramework.Dictionary,
    container: HTMLDivElement
  ): void {
    this.context = context;
    this.notifyOutputChanged = notifyOutputChanged;
    this.container = container;
    this.container.style.width = "100%";
    this.container.style.height = "100%";
    this.container.style.overflow = "auto";
    this.container.style.position = "relative";
    this.container.innerHTML = "";
  }

  public updateView(context: ComponentFramework.Context<IInputs>): void {
    this.context = context;

    const ds = context.parameters.cp_mat;

    if (!ds || ds.loading) {
      this.renderStatus(ds?.loading ? "⏳ Loading mats..." : "❌ Dataset not bound.");
      return;
    }

    // Read designer properties with safe defaults
    this.scale   = (context.parameters.Scale?.raw   as number) || 1;
    this.offsetX = (context.parameters.OffsetX?.raw as number) || 0;
    this.offsetY = (context.parameters.OffsetY?.raw as number) || 0;
    const baseW  = (context.parameters.BaseW?.raw   as number) || 1200;
    const baseH  = (context.parameters.BaseH?.raw   as number) || 800;
    const isLayoutMode = (context.parameters.IsLayoutMode?.raw as boolean) || false;

    const mats = this.readMatsFromDataset(ds);
    this.currentMats = mats;
    const overlaps = this.findOverlaps(mats);

    // ── Build the SVG ────────────────────────────────────────────────────────
    this.container.innerHTML = "";

    const svgNS = "http://www.w3.org/2000/svg";

    // Outer wrapper so we can show overlap banner beneath the SVG
    const wrapper = document.createElement("div");
    wrapper.style.display = "flex";
    wrapper.style.flexDirection = "column";
    wrapper.style.width = "100%";
    wrapper.style.height = "100%";

    // ── SVG canvas ───────────────────────────────────────────────────────────
    const svg = document.createElementNS(svgNS, "svg");
    const canvasW = baseW * this.scale;
    const canvasH = baseH * this.scale;
    svg.setAttribute("width",  String(canvasW));
    svg.setAttribute("height", String(canvasH));
    svg.setAttribute("viewBox", `0 0 ${canvasW} ${canvasH}`);
    svg.style.display = "block";
    svg.style.background = "#f0ede8"; // floor colour
    svg.style.border = "2px solid #333";
    svg.style.cursor = "default";
    svg.style.flexShrink = "0";

    // ── Grid (visual aid) ────────────────────────────────────────────────────
    const defs = document.createElementNS(svgNS, "defs");
    const gridSize = 20 * this.scale;
    const pattern = document.createElementNS(svgNS, "pattern");
    pattern.setAttribute("id", "grid");
    pattern.setAttribute("width",  String(gridSize));
    pattern.setAttribute("height", String(gridSize));
    pattern.setAttribute("patternUnits", "userSpaceOnUse");
    const gridLine = document.createElementNS(svgNS, "path");
    gridLine.setAttribute("d", `M ${gridSize} 0 L 0 0 0 ${gridSize}`);
    gridLine.setAttribute("fill", "none");
    gridLine.setAttribute("stroke", "#ccc");
    gridLine.setAttribute("stroke-width", "0.5");
    pattern.appendChild(gridLine);
    defs.appendChild(pattern);
    svg.appendChild(defs);

    const gridRect = document.createElementNS(svgNS, "rect");
    gridRect.setAttribute("width",  "100%");
    gridRect.setAttribute("height", "100%");
    gridRect.setAttribute("fill", "url(#grid)");
    svg.appendChild(gridRect);

    // ── Draw each mat ────────────────────────────────────────────────────────
    for (const mat of mats) {
      const g = document.createElementNS(svgNS, "g");
      g.setAttribute("data-id", mat.id);
      g.style.cursor = isLayoutMode ? "move" : "pointer";

      const px = (mat.x + this.offsetX) * this.scale;
      const py = (mat.y + this.offsetY) * this.scale;
      const pw = mat.w * this.scale;
      const ph = mat.h * this.scale;

      // Skip mats with zero/negative size
      if (pw <= 0 || ph <= 0) continue;

      const fillColor   = mat.cp_fillcolor   || "#A0A972";
      const strokeColor = mat.cp_strokecolor || "#383838";
      const strokeWidth = 3 * this.scale;

      // Background rectangle
      const rect = document.createElementNS(svgNS, "rect");
      rect.setAttribute("x",      String(px));
      rect.setAttribute("y",      String(py));
      rect.setAttribute("width",  String(pw));
      rect.setAttribute("height", String(ph));
      rect.setAttribute("fill",   fillColor);
      rect.setAttribute("stroke", strokeColor);
      rect.setAttribute("stroke-width", String(strokeWidth));
      rect.setAttribute("rx", "4");
      g.appendChild(rect);

      // Label text
      const label = mat.cp_matlabel
        ?? (mat.cp_matnumber != null ? `Mat ${mat.cp_matnumber}` : "");

      if (label) {
        const fontSize = Math.max(10, Math.min(14, pw / 5)) * this.scale;
        const text = document.createElementNS(svgNS, "text");
        text.setAttribute("x", String(px + pw / 2));
        text.setAttribute("y", String(py + ph / 2));
        text.setAttribute("text-anchor", "middle");
        text.setAttribute("dominant-baseline", "middle");
        text.setAttribute("font-size", String(fontSize));
        text.setAttribute("font-family", "Segoe UI, sans-serif");
        text.setAttribute("fill", "#fff");
        text.setAttribute("pointer-events", "none");
        text.textContent = label;
        g.appendChild(text);
      }

      // ── Drag handling (layout mode only) ───────────────────────────────
      if (isLayoutMode) {
        g.addEventListener("mousedown", (e: MouseEvent) => {
          e.preventDefault();
          this.dragging    = true;
          this.dragMatId   = mat.id;
          const svgRect    = svg.getBoundingClientRect();
          this.dragOffsetX = (e.clientX - svgRect.left) / this.scale - mat.x - this.offsetX;
          this.dragOffsetY = (e.clientY - svgRect.top)  / this.scale - mat.y - this.offsetY;
          this.dragStartX  = mat.x;
          this.dragStartY  = mat.y;
        });
      }

      svg.appendChild(g);
    }

    // ── SVG-level mouse events for dragging ──────────────────────────────────
    svg.addEventListener("mousemove", (e: MouseEvent) => {
      if (!this.dragging) return;
      const svgRect = svg.getBoundingClientRect();
      const rawX = (e.clientX - svgRect.left) / this.scale - this.offsetX - this.dragOffsetX;
      const rawY = (e.clientY - svgRect.top)  / this.scale - this.offsetY - this.dragOffsetY;

      // Snap to 5-unit grid
      const snapX = Math.round(rawX / 5) * 5;
      const snapY = Math.round(rawY / 5) * 5;

      // Move the SVG group visually without waiting for a full re-render
      const draggedG = svg.querySelector(`g[data-id="${this.dragMatId}"]`) as SVGGElement | null;
      if (draggedG) {
        const mat = this.currentMats.find(m => m.id === this.dragMatId);
        if (mat) {
          const dx = (snapX - mat.x) * this.scale;
          const dy = (snapY - mat.y) * this.scale;
          draggedG.setAttribute("transform", `translate(${dx},${dy})`);
        }
      }

      this.newX = snapX;
      this.newY = snapY;
    });

    svg.addEventListener("mouseup", () => {
      if (!this.dragging) return;
      this.dragging = false;

      // Only fire output if position actually changed
      if (this.newX !== this.dragStartX || this.newY !== this.dragStartY) {
        this.selectedId  = this.dragMatId;
        this.changeKind  = "move";
        this.notifyOutputChanged();
      }
    });

    svg.addEventListener("mouseleave", () => {
      if (this.dragging) {
        this.dragging = false;
      }
    });

    wrapper.appendChild(svg);

    // ── Overlap warning banner ───────────────────────────────────────────────
    if (overlaps.length > 0) {
      const banner = document.createElement("div");
      banner.style.cssText = `
        background:#fff3cd; border:1px solid #ffc107;
        color:#856404; padding:8px 12px; font-size:13px;
        font-family:Segoe UI,sans-serif; margin-top:6px;
        border-radius:4px; white-space:pre-wrap;
      `;
      banner.textContent = `⚠️ Overlaps detected:\n${overlaps.map(o => `  • ${o}`).join("\n")}`;
      wrapper.appendChild(banner);
    }

    this.container.appendChild(wrapper);
  }

  public getOutputs(): IOutputs {
    return {
      SelectedId: this.selectedId,
      ChangeKind: this.changeKind,
      NewX: this.newX,
      NewY: this.newY,
      NewW: this.newW,
      NewH: this.newH,
    };
  }

  public destroy(): void {
    this.container.innerHTML = "";
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private renderStatus(message: string): void {
    this.container.innerHTML = "";
    const pre = document.createElement("pre");
    pre.style.fontFamily = "Segoe UI, sans-serif";
    pre.style.padding = "12px";
    pre.textContent = message;
    this.container.appendChild(pre);
  }

  private readMatsFromDataset(
    ds: ComponentFramework.PropertyTypes.DataSet
  ): MatRow[] {
    if (!ds?.sortedRecordIds?.length) return [];

    const rows: MatRow[] = [];

    for (const id of ds.sortedRecordIds) {
      const rec = ds.records[id];
      if (!rec) continue;

      const cp_matlabel   = this.getString(rec, "cp_matlabel");
      const cp_matnumber  = this.getNumber(rec, "cp_matnumber");
      const cp_matwidth   = this.getNumber(rec, "cp_matwidth");
      const cp_matheight  = this.getNumber(rec, "cp_matheight");
      const cp_xposition  = this.getNumber(rec, "cp_xposition");
      const cp_yposition  = this.getNumber(rec, "cp_yposition");
      const cp_fillcolor  = this.getString(rec, "cp_fillcolor");
      const cp_strokecolor = this.getString(rec, "cp_strokecolor");

      rows.push({
        id,
        cp_matlabel,
        cp_matnumber,
        cp_matwidth,
        cp_matheight,
        cp_xposition,
        cp_yposition,
        cp_fillcolor,
        cp_strokecolor,
        x: cp_xposition ?? 0,
        y: cp_yposition ?? 0,
        w: cp_matwidth  ?? 0,
        h: cp_matheight ?? 0,
      });
    }

    return rows;
  }

  private getString(
    rec: ComponentFramework.PropertyHelper.DataSetApi.EntityRecord,
    logicalName: string
  ): string | null {
    const raw = rec.getValue(logicalName);
    if (raw == null) return null;
    return String(raw);
  }

  private getNumber(
    rec: ComponentFramework.PropertyHelper.DataSetApi.EntityRecord,
    logicalName: string
  ): number | null {
    const raw = rec.getValue(logicalName);
    if (raw == null || raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  private isOverlapping(a: MatRow, b: MatRow): boolean {
    return !(
      a.x + a.w <= b.x ||
      b.x + b.w <= a.x ||
      a.y + a.h <= b.y ||
      b.y + b.h <= a.y
    );
  }

  private findOverlaps(mats: MatRow[]): string[] {
    const issues: string[] = [];
    for (let i = 0; i < mats.length; i++) {
      for (let j = i + 1; j < mats.length; j++) {
        const a = mats[i], b = mats[j];
        if (a.w <= 0 || a.h <= 0 || b.w <= 0 || b.h <= 0) continue;
        if (this.isOverlapping(a, b)) {
          const aLabel = a.cp_matlabel ?? (a.cp_matnumber != null ? `Mat ${a.cp_matnumber}` : a.id);
          const bLabel = b.cp_matlabel ?? (b.cp_matnumber != null ? `Mat ${b.cp_matnumber}` : b.id);
          issues.push(`${aLabel} overlaps ${bLabel}`);
        }
      }
    }
    return issues;
  }
}

// Commit message: Initial implementation of MatsOverlay control with SVG rendering, drag-and-drop layout, and overlap detection.