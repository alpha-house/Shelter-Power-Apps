import { IInputs, IOutputs } from "./generated/ManifestTypes";

type Guid = string;

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

interface LookupResult {
  entityType: string;
  id: string; // "{GUID}" format from Xrm
  name: string;
}
interface LookupFilter {
  entityLogicalName: string;
  filterXml: string;
}
interface LookupOptions {
  allowMultiSelect?: boolean;
  entityTypes: string[];
  defaultEntityType?: string;
  defaultViewId?: string;
  viewIds?: string[];
  searchText?: string;
  filters?: LookupFilter[];
}
interface XrmUtilityLike {
  lookupObjects(opts: LookupOptions): Promise<LookupResult[]>;
}
interface XrmLike {
  Utility: XrmUtilityLike;
}
interface AlertDialogStrings { text: string; title?: string; confirmButtonLabel?: string; }
interface AlertDialogOptions { height?: number; width?: number; }

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

  // ── Navigation property names — confirmed from $metadata NavProp query ──────
  //
  //   cp_ShelterCheckin  → confirmed by: fetch $metadata, NavProp on cp_mat
  //   cp_Client          → confirmed by: working processAssessmentAndCreateAdmission JS
  //
  // Entity set names (stable for custom entities — logical name + "s"):
  //   cp_sheltercheckin → cp_sheltercheckins
  //   contact           → contacts
  //
  private static readonly NAV_CHECKIN = "cp_ShelterCheckin";  // ✅ confirmed
  private static readonly NAV_CLIENT  = "cp_Client";           // ✅ confirmed
  private static readonly SET_CHECKIN = "cp_sheltercheckins";
  private static readonly SET_CONTACT = "contacts";

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

    this.scale      = (context.parameters.Scale?.raw   as number)  || 1;
    this.offsetX    = (context.parameters.OffsetX?.raw as number)  || 0;
    this.offsetY    = (context.parameters.OffsetY?.raw as number)  || 0;
    const baseW     = (context.parameters.BaseW?.raw   as number)  || 1200;
    const baseH     = (context.parameters.BaseH?.raw   as number)  || 800;
    const isLayoutMode = (context.parameters.IsLayoutMode?.raw as boolean) || false;

    const mats = this.readMatsFromDataset(ds);
    this.currentMats = mats;
    const overlaps = this.findOverlaps(mats);

    this.container.innerHTML = "";

    const doc   = this.container.ownerDocument!;
    const svgNS = "http://www.w3.org/2000/svg";

    const wrapper = doc.createElement("div");
    wrapper.style.display       = "flex";
    wrapper.style.flexDirection = "column";
    wrapper.style.width         = "100%";
    wrapper.style.height        = "100%";

    // ── SVG canvas ────────────────────────────────────────────────────────────
    const svg     = doc.createElementNS(svgNS, "svg");
    const canvasW = baseW * this.scale;
    const canvasH = baseH * this.scale;
    svg.setAttribute("width",   String(canvasW));
    svg.setAttribute("height",  String(canvasH));
    svg.setAttribute("viewBox", `0 0 ${canvasW} ${canvasH}`);
    (svg as unknown as HTMLElement).style.display    = "block";
    (svg as unknown as HTMLElement).style.background = "#f0ede8";
    (svg as unknown as HTMLElement).style.border     = "2px solid #333";
    (svg as unknown as HTMLElement).style.cursor     = "default";
    (svg as unknown as HTMLElement).style.flexShrink = "0";

    // ── Grid ──────────────────────────────────────────────────────────────────
    const defs     = doc.createElementNS(svgNS, "defs");
    const gridSize = 20 * this.scale;
    const pattern  = doc.createElementNS(svgNS, "pattern");
    pattern.setAttribute("id",           "grid");
    pattern.setAttribute("width",        String(gridSize));
    pattern.setAttribute("height",       String(gridSize));
    pattern.setAttribute("patternUnits", "userSpaceOnUse");
    const gridLine = doc.createElementNS(svgNS, "path");
    gridLine.setAttribute("d",            `M ${gridSize} 0 L 0 0 0 ${gridSize}`);
    gridLine.setAttribute("fill",         "none");
    gridLine.setAttribute("stroke",       "#ccc");
    gridLine.setAttribute("stroke-width", "0.5");
    pattern.appendChild(gridLine);
    defs.appendChild(pattern);
    svg.appendChild(defs);

    const gridRect = doc.createElementNS(svgNS, "rect");
    gridRect.setAttribute("width",  "100%");
    gridRect.setAttribute("height", "100%");
    gridRect.setAttribute("fill",   "url(#grid)");
    svg.appendChild(gridRect);

    // ── Draw each mat ─────────────────────────────────────────────────────────
    for (const mat of mats) {
      const g = doc.createElementNS(svgNS, "g");
      g.setAttribute("data-id", mat.id);
      (g as unknown as HTMLElement).style.cursor = isLayoutMode ? "move" : "pointer";

      const px = (mat.x + this.offsetX) * this.scale;
      const py = (mat.y + this.offsetY) * this.scale;
      const pw = mat.w * this.scale;
      const ph = mat.h * this.scale;

      if (pw <= 0 || ph <= 0) continue;

      const fillColor   = mat.cp_fillcolor   || "#A0A972";
      const strokeColor = mat.cp_strokecolor || "#383838";
      const strokeWidth = 3 * this.scale;

      const rect = doc.createElementNS(svgNS, "rect");
      rect.setAttribute("x",            String(px));
      rect.setAttribute("y",            String(py));
      rect.setAttribute("width",        String(pw));
      rect.setAttribute("height",       String(ph));
      rect.setAttribute("fill",         fillColor);
      rect.setAttribute("stroke",       strokeColor);
      rect.setAttribute("stroke-width", String(strokeWidth));
      rect.setAttribute("rx",           "4");
      g.appendChild(rect);

      const label = mat.cp_matlabel ?? (mat.cp_matnumber != null ? `Mat ${mat.cp_matnumber}` : "");
      if (label) {
        const fontSize = Math.max(10, Math.min(14, pw / 5)) * this.scale;
        const text = doc.createElementNS(svgNS, "text");
        text.setAttribute("x",                  String(px + pw / 2));
        text.setAttribute("y",                  String(py + ph / 2));
        text.setAttribute("text-anchor",        "middle");
        text.setAttribute("dominant-baseline",  "middle");
        text.setAttribute("font-size",          String(fontSize));
        text.setAttribute("font-family",        "Segoe UI, sans-serif");
        text.setAttribute("fill",              "#fff");
        text.setAttribute("pointer-events",    "none");
        text.textContent = label;
        g.appendChild(text);
      }

      if (isLayoutMode) {
        // ── Layout mode: drag to reposition ───────────────────────────────
        g.addEventListener("mousedown", (e: MouseEvent) => {
          e.preventDefault();
          this.dragging    = true;
          this.dragMatId   = mat.id;
          const svgRect    = (svg as unknown as HTMLElement).getBoundingClientRect();
          this.dragOffsetX = (e.clientX - svgRect.left) / this.scale - mat.x - this.offsetX;
          this.dragOffsetY = (e.clientY - svgRect.top)  / this.scale - mat.y - this.offsetY;
          this.dragStartX  = mat.x;
          this.dragStartY  = mat.y;
        });
      } else {
        // ── Normal mode: click to assign a check-in ────────────────────────
        g.addEventListener("click", () => {
          this.pickAndAssign(mat).catch((err: unknown) => {
            console.error("[MatsOverlay] pickAndAssign error:", err);
          });
        });
      }

      svg.appendChild(g);
    }

    // ── Drag events ───────────────────────────────────────────────────────────
    svg.addEventListener("mousemove", (e: MouseEvent) => {
      if (!this.dragging) return;
      const svgRect = (svg as unknown as HTMLElement).getBoundingClientRect();
      const rawX  = (e.clientX - svgRect.left) / this.scale - this.offsetX - this.dragOffsetX;
      const rawY  = (e.clientY - svgRect.top)  / this.scale - this.offsetY - this.dragOffsetY;
      const snapX = Math.round(rawX / 5) * 5;
      const snapY = Math.round(rawY / 5) * 5;

      const draggedG = svg.querySelector(`g[data-id="${this.dragMatId}"]`) as SVGGElement | null;
      if (draggedG) {
        const mat = this.currentMats.find(m => m.id === this.dragMatId);
        if (mat) {
          draggedG.setAttribute(
            "transform",
            `translate(${(snapX - mat.x) * this.scale},${(snapY - mat.y) * this.scale})`
          );
        }
      }
      this.newX = snapX;
      this.newY = snapY;
    });

    svg.addEventListener("mouseup", () => {
      if (!this.dragging) return;
      this.dragging = false;
      if (this.newX !== this.dragStartX || this.newY !== this.dragStartY) {
        this.selectedId = this.dragMatId;
        this.changeKind = "move";
        this.notifyOutputChanged();
      }
    });

    svg.addEventListener("mouseleave", () => { this.dragging = false; });

    wrapper.appendChild(svg);

    // ── Overlap warning ───────────────────────────────────────────────────────
    if (overlaps.length > 0) {
      const banner = doc.createElement("div");
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

  // ── Pick & Assign ───────────────────────────────────────────────────────────

  /**
   * 1. Opens the Xrm native lookup dialog filtered to active check-in records.
   * 2. Fetches _cp_client_value from the selected check-in automatically.
   * 3. Writes both lookups to cp_mat with a single WebAPI PATCH using
   *    the confirmed navigation property names:
   *      cp_ShelterCheckin  (confirmed from $metadata NavProp query)
   *      cp_Client          (confirmed from working JS)
   */
  private async pickAndAssign(mat: MatRow): Promise<void> {
    const xrm      = this.getXrm();
    const matLabel = mat.cp_matlabel ?? (mat.cp_matnumber != null ? `Mat ${mat.cp_matnumber}` : mat.id);

    // ── Step 1: Native Xrm lookup dialog — filtered to active check-ins ──────
    let scPick: LookupResult[];
    try {
      scPick = await xrm.Utility.lookupObjects({
        entityTypes:    ["cp_sheltercheckin"],
        allowMultiSelect: false,
        filters: [{
          entityLogicalName: "cp_sheltercheckin",
          filterXml:
            "<filter type='and'>" +
              "<condition attribute='cp_checkin' operator='eq' value='1' />" +
              "<condition attribute='statecode'  operator='eq' value='0' />" +
            "</filter>"
        }]
      });
    } catch {
      return; // user dismissed the dialog
    }
    if (!scPick || scPick.length === 0) return;

    const shelterCheckinId: Guid = scPick[0].id.replace(/[{}]/g, "");

    // ── Step 2: Read _cp_client_value from the chosen check-in ───────────────
    //    Copies the client automatically — no second lookup dialog needed.
    let contactId: Guid | null = null;
    try {
      const ciRecord = await this.context.webAPI.retrieveRecord(
        "cp_sheltercheckin",
        shelterCheckinId,
        "?$select=_cp_client_value"
      );
      const raw = ciRecord["_cp_client_value"] as string | null | undefined;
      contactId = raw ? raw.replace(/[{}]/g, "") : null;
    } catch (err) {
      console.warn("[MatsOverlay] Could not read _cp_client_value:", err);
    }

    // ── Step 3: Build PATCH payload with confirmed nav property names ─────────
    //
    //   ✅ cp_ShelterCheckin  — confirmed from $metadata NavProp query on cp_mat
    //   ✅ cp_Client          — confirmed from working processAssessmentAndCreateAdmission JS
    //
    const payload: Record<string, string | null> = {
      [`${MatsOverlay.NAV_CHECKIN}@odata.bind`]:
        `/${MatsOverlay.SET_CHECKIN}(${shelterCheckinId})`,
      [`${MatsOverlay.NAV_CLIENT}@odata.bind`]:
        contactId ? `/${MatsOverlay.SET_CONTACT}(${contactId})` : null,
    };

    console.log(`[MatsOverlay] PATCH cp_mat/${mat.id}:`, JSON.stringify(payload));

    // ── Step 4: Write to Dataverse ────────────────────────────────────────────
    await this.context.webAPI.updateRecord("cp_mat", mat.id, payload);

    const clientMsg = contactId
      ? "Check-in & client assigned."
      : "Check-in assigned (no client linked to this check-in).";
    await this.showAlert(`✅ ${matLabel}: ${clientMsg}`);

    // Refresh dataset so colours/labels reflect the new state immediately
    await this.context.parameters.cp_mat.refresh();
  }

  /**
   * Clears both the Shelter Check-In and Client lookups on a cp_mat record.
   * Wire to a right-click context menu or toolbar button as needed.
   */
  private async clearAssignments(mat: MatRow): Promise<void> {
    const payload: Record<string, string | null> = {
      [`${MatsOverlay.NAV_CHECKIN}@odata.bind`]: null,
      [`${MatsOverlay.NAV_CLIENT}@odata.bind`]:  null,
    };

    console.log(`[MatsOverlay] Clearing cp_mat/${mat.id}:`, JSON.stringify(payload));

    await this.context.webAPI.updateRecord("cp_mat", mat.id, payload);
    await this.showAlert(`🗑️ Assignment cleared for ${mat.cp_matlabel ?? "mat"}.`);
    await this.context.parameters.cp_mat.refresh();
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private async showAlert(text: string, title = "Mats Overlay"): Promise<void> {
    const strings: AlertDialogStrings = { text, title };
    const options: AlertDialogOptions = { height: 150, width: 320 };
    await this.context.navigation.openAlertDialog(strings, options);
  }

  private getXrm(): XrmLike {
    const w = (window as unknown as { Xrm?: XrmLike });
    if (!w.Xrm?.Utility) throw new Error("Xrm.Utility is not available in this context.");
    return w.Xrm;
  }

  public getOutputs(): IOutputs {
    return {
      SelectedId: this.selectedId,
      ChangeKind: this.changeKind,
      NewX:       this.newX,
      NewY:       this.newY,
      NewW:       this.newW,
      NewH:       this.newH,
    };
  }

  public destroy(): void {
    this.container.innerHTML = "";
  }

  private renderStatus(message: string): void {
    this.container.innerHTML = "";
    const doc = this.container.ownerDocument!;
    const pre = doc.createElement("pre");
    pre.style.fontFamily = "Segoe UI, sans-serif";
    pre.style.padding    = "12px";
    pre.textContent      = message;
    this.container.appendChild(pre);
  }

  private readMatsFromDataset(ds: ComponentFramework.PropertyTypes.DataSet): MatRow[] {
    if (!ds?.sortedRecordIds?.length) return [];
    const rows: MatRow[] = [];
    for (const id of ds.sortedRecordIds) {
      const rec = ds.records[id];
      if (!rec) continue;
      const cp_matlabel    = this.getString(rec, "cp_matlabel");
      const cp_matnumber   = this.getNumber(rec, "cp_matnumber");
      const cp_matwidth    = this.getNumber(rec, "cp_matwidth");
      const cp_matheight   = this.getNumber(rec, "cp_matheight");
      const cp_xposition   = this.getNumber(rec, "cp_xposition");
      const cp_yposition   = this.getNumber(rec, "cp_yposition");
      const cp_fillcolor   = this.getString(rec, "cp_fillcolor");
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