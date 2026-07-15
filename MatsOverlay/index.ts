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
  cp_matgender?: string | null;
  // Whether this mat already has a check-in assigned — drives click behaviour
  hasCheckin: boolean;
  // Resolved id of the linked cp_sheltercheckin record, lower-cased, no braces
  checkinId: string | null;
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
interface PageContextEntityFormInput {
  pageType: string;
  entityName?: string;
  entityId?: string;
}
interface PageContext {
  input?: PageContextEntityFormInput;
}
interface XrmUtilityLike {
  lookupObjects(opts: LookupOptions): Promise<LookupResult[]>;
  getPageContext(): PageContext;
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

  // ── Breathing round status cache — keyed by lower-cased cp_sheltercheckin id ─
  private breathingRoundById = new Map<string, boolean>();
  private breathingRoundFetchInFlight = false;
  private breathingRoundLastFetch = 0;

  // ── Navigation property names — confirmed from $metadata NavProp query ──────
  //   cp_ShelterCheckin  → confirmed by $metadata NavProp query on cp_mat
  //   cp_Client          → confirmed by working processAssessmentAndCreateAdmission JS
  //   cp_BreathingRoundModifiedBy → confirmed by $metadata ManyToOneRelationships query on cp_sheltercheckin
  //   cp_MatPlan         → NOT YET CONFIRMED against $metadata. Assumed by convention
  //                        (matches the PascalCase-of-schema-name pattern used by the
  //                        two confirmed nav props above). Verify via:
  //                        {org}/api/data/v9.2/EntityDefinitions(LogicalName='cp_mat')/ManyToOneRelationships?$select=ReferencingEntityNavigationPropertyName,ReferencingAttribute&$filter=ReferencingAttribute eq 'cp_matplan'
  //                        and update this constant if it differs.
  private static readonly NAV_CHECKIN = "cp_ShelterCheckin";
  private static readonly NAV_CLIENT  = "cp_Client";
  private static readonly NAV_BREATHING_ROUND_MODIFIED_BY = "cp_BreathingRoundModifiedBy";
  private static readonly NAV_MATPLAN = "cp_MatPlan";
  private static readonly SET_CHECKIN     = "cp_sheltercheckins";
  private static readonly SET_CONTACT     = "contacts";
  private static readonly SET_SYSTEMUSER  = "systemusers";
  private static readonly SET_MATPLAN     = "cp_matplans";
  private static readonly MATGENDER_OPTIONS = ["Male", "Female"];

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

    this.refreshBreathingRoundIndicators().catch((err: unknown) => {
      console.error("[MatsOverlay] refreshBreathingRoundIndicators error:", err);
    });

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
        text.setAttribute("x",                 String(px + pw / 2));
        text.setAttribute("y",                 String(py + ph / 2));
        text.setAttribute("text-anchor",       "middle");
        text.setAttribute("dominant-baseline", "middle");
        text.setAttribute("font-size",         String(fontSize));
        text.setAttribute("font-family",       "Segoe UI, sans-serif");
        text.setAttribute("fill",              "#fff");
        text.setAttribute("pointer-events",    "none");
        text.textContent = label;
        g.appendChild(text);
      }

      // ── Breathing round indicator — small badge in the top-right corner ─────
      // Green once cp_breathinground is true on the linked check-in, amber otherwise.
      // Inset from the corner by radius + half the stroke width so the whole
      // badge (including its stroke) sits fully inside the mat's rectangle.
      const breathingDone     = !!mat.checkinId && this.breathingRoundById.get(mat.checkinId) === true;
      const badgeRadius       = Math.max(6, Math.min(12, Math.min(pw, ph) / 3)) * this.scale;
      const badgeStrokeWidth  = 3 * this.scale;
      const badgeInset        = badgeRadius + badgeStrokeWidth / 2;
      const badge = doc.createElementNS(svgNS, "circle");
      badge.setAttribute("cx",           String(px + pw - badgeInset));
      badge.setAttribute("cy",           String(py + badgeInset));
      badge.setAttribute("r",            String(badgeRadius));
      badge.setAttribute("fill",         breathingDone ? "#00E676" : "#FFC400");
      badge.setAttribute("stroke",       "#fff");
      badge.setAttribute("stroke-width", String(badgeStrokeWidth));
      badge.setAttribute("pointer-events", "none");
      g.appendChild(badge);

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
        // Swallow the click that follows mouseup so it doesn't bubble to the
        // background handler and get mistaken for an empty-canvas click.
        g.addEventListener("click", (e: MouseEvent) => { e.stopPropagation(); });
      } else {
        // ── Normal mode: left-click always opens the manage menu ───────────
        g.addEventListener("click", (e: MouseEvent) => {
          e.stopPropagation(); // prevent SVG background click from dismissing immediately
          this.showMatMenu(mat, e.clientX, e.clientY);
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

    // Clicking the SVG background (i.e. not on an existing mat — mat groups
    // stop propagation) dismisses any open dialog and opens the "Add Mat"
    // dialog at the clicked location.
    svg.addEventListener("click", (e: MouseEvent) => {
      this.dismissAllDialogs();
      const svgRect = (svg as unknown as HTMLElement).getBoundingClientRect();
      const rawX = (e.clientX - svgRect.left) / this.scale - this.offsetX;
      const rawY = (e.clientY - svgRect.top)  / this.scale - this.offsetY;
      this.showAddMatDialog(rawX, rawY, e.clientX, e.clientY);
    });

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

  // ── Mat menu ──────────────────────────────────────────────────────────────────

  /**
   * Floating dialog shown when a mat is clicked in normal mode. Occupied mats
   * (already have a check-in) get breathing-round / removal actions; vacant
   * mats get an "Assign Client" action. Both get "Edit Mat Properties".
   */
  private showMatMenu(mat: MatRow, clientX: number, clientY: number): void {
    this.dismissAllDialogs();

    const matLabel = mat.cp_matlabel ?? (mat.cp_matnumber != null ? `Mat ${mat.cp_matnumber}` : mat.id);
    const doc      = this.container.ownerDocument!;

    // Transparent backdrop — clicks outside dismiss the dialog
    const backdrop = doc.createElement("div");
    backdrop.id = "matsOverlay-remove-backdrop";
    backdrop.style.cssText = "position:fixed;inset:0;z-index:99998;background:transparent;";
    backdrop.addEventListener("click", () => this.dismissMatMenu());

    // Floating panel
    const menu = doc.createElement("div");
    menu.id = "matsOverlay-remove-menu";
    menu.style.cssText = `
      position:fixed; left:${clientX}px; top:${clientY}px;
      z-index:99999; background:#fff;
      border:1px solid #d0d0d0; border-radius:8px;
      box-shadow:0 6px 24px rgba(0,0,0,0.18);
      font-family:Segoe UI,sans-serif; font-size:13px;
      min-width:230px; overflow:hidden;
    `;

    // Header
    const header = doc.createElement("div");
    header.style.cssText = `
      background:#2b579a; color:#fff;
      padding:10px 16px; font-weight:600; font-size:13px;
    `;
    header.textContent = `⚙️ ${matLabel} — manage assignment`;
    menu.appendChild(header);

    const divider = (): HTMLElement => {
      const d = doc.createElement("div");
      d.style.cssText = "height:1px;background:#eee;";
      return d;
    };

    const makeBtn = (icon: string, label: string, danger: boolean, onClick: () => void): HTMLElement => {
      const btn = doc.createElement("div");
      btn.style.cssText = `
        padding:11px 16px; cursor:pointer;
        color:${danger ? "#c00" : "#333"};
        display:flex; align-items:center; gap:10px;
        transition:background 0.12s;
      `;
      const iconEl = doc.createElement("span");
      iconEl.textContent = icon;
      iconEl.style.fontSize = "15px";
      const labelEl = doc.createElement("span");
      labelEl.textContent = label;
      btn.appendChild(iconEl);
      btn.appendChild(labelEl);
      btn.addEventListener("mouseenter", () => { btn.style.background = danger ? "#fff5f5" : "#f4f7ff"; });
      btn.addEventListener("mouseleave", () => { btn.style.background = "#fff"; });
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.dismissMatMenu();
        onClick();
      });
      return btn;
    };

    if (mat.hasCheckin) {
      menu.appendChild(makeBtn("🫁", "Complete Breathing Round", false, () => {
        this.completeBreathingRound(mat).catch((err: unknown) => {
          console.error("[MatsOverlay] completeBreathingRound error:", err);
        });
      }));
      menu.appendChild(divider());
    } else {
      menu.appendChild(makeBtn("📌", "Assign Client", false, () => {
        this.pickAndAssign(mat).catch((err: unknown) => {
          console.error("[MatsOverlay] pickAndAssign error:", err);
        });
      }));
      menu.appendChild(divider());
    }

    menu.appendChild(makeBtn("✏️", "Edit Mat Properties", false, () => {
      this.showEditMatDialog(mat, clientX, clientY);
    }));

    menu.appendChild(divider());

    if (mat.hasCheckin) {
      menu.appendChild(makeBtn("🗑️", "Remove Client", true, () => {
        this.removeFields(mat, true, true).catch((err: unknown) => {
          console.error("[MatsOverlay] removeFields error:", err);
        });
      }));
      menu.appendChild(divider());
    }

    menu.appendChild(makeBtn("✕", "Cancel", false, () => { /* already dismissed */ }));

    doc.body.appendChild(backdrop);
    doc.body.appendChild(menu);

    // Nudge inside viewport if it overflows
    const r = menu.getBoundingClientRect();
    if (r.right  > window.innerWidth)  menu.style.left = `${clientX - r.width  - 4}px`;
    if (r.bottom > window.innerHeight) menu.style.top  = `${clientY - r.height - 4}px`;
  }

  private dismissMatMenu(): void {
    const doc = this.container.ownerDocument!;
    doc.getElementById("matsOverlay-remove-backdrop")?.remove();
    doc.getElementById("matsOverlay-remove-menu")?.remove();
  }

  private dismissAllDialogs(): void {
    this.dismissMatMenu();
    this.dismissMatFormDialog();
  }

  // ── Mat properties dialog (Add / Edit) ───────────────────────────────────────

  private dismissMatFormDialog(): void {
    const doc = this.container.ownerDocument!;
    doc.getElementById("matsOverlay-form-backdrop")?.remove();
    doc.getElementById("matsOverlay-form-dialog")?.remove();
  }

  /**
   * Opens the "Add Mat" dialog pre-filled with defaults, centered on the
   * clicked canvas location. rawX/rawY are unscaled canvas coordinates
   * (same space as cp_xposition/cp_yposition).
   */
  private showAddMatDialog(rawX: number, rawY: number, clientX: number, clientY: number): void {
    const defaultWidth  = 69;
    const defaultHeight = 150;
    const snap = (n: number): number => Math.round(n / 5) * 5;
    const xPosition = Math.max(0, snap(rawX - defaultWidth  / 2));
    const yPosition = Math.max(0, snap(rawY - defaultHeight / 2));

    this.showMatFormDialog({
      title: "➕ Add Mat",
      clientX,
      clientY,
      saveLabel: "Add Mat",
      initial: {
        label:  "Overflow",
        width:  defaultWidth,
        height: defaultHeight,
        x:      xPosition,
        y:      yPosition,
        gender: MatsOverlay.MATGENDER_OPTIONS[0],
      },
      onSave: (values) => this.createMat(values),
    });
  }

  /** Opens the "Edit Mat Properties" dialog pre-filled with the mat's current values. */
  private showEditMatDialog(mat: MatRow, clientX: number, clientY: number): void {
    const matLabel = mat.cp_matlabel ?? (mat.cp_matnumber != null ? `Mat ${mat.cp_matnumber}` : mat.id);
    this.showMatFormDialog({
      title: `✏️ Edit ${matLabel}`,
      clientX,
      clientY,
      saveLabel: "Save",
      initial: {
        label:  mat.cp_matlabel ?? "",
        width:  mat.cp_matwidth  ?? 0,
        height: mat.cp_matheight ?? 0,
        x:      mat.cp_xposition ?? 0,
        y:      mat.cp_yposition ?? 0,
        gender: mat.cp_matgender ?? MatsOverlay.MATGENDER_OPTIONS[0],
      },
      onSave: (values) => this.updateMatProperties(mat, values),
    });
  }

  private showMatFormDialog(opts: {
    title: string;
    clientX: number;
    clientY: number;
    saveLabel: string;
    initial: { label: string; width: number; height: number; x: number; y: number; gender: string };
    onSave: (values: { label: string; width: number; height: number; x: number; y: number; gender: string }) => Promise<void>;
  }): void {
    this.dismissAllDialogs();

    const doc = this.container.ownerDocument!;

    const backdrop = doc.createElement("div");
    backdrop.id = "matsOverlay-form-backdrop";
    backdrop.style.cssText = "position:fixed;inset:0;z-index:99998;background:transparent;";
    backdrop.addEventListener("click", () => this.dismissMatFormDialog());

    const dialog = doc.createElement("div");
    dialog.id = "matsOverlay-form-dialog";
    dialog.style.cssText = `
      position:fixed; left:${opts.clientX}px; top:${opts.clientY}px;
      z-index:99999; background:#fff;
      border:1px solid #d0d0d0; border-radius:8px;
      box-shadow:0 6px 24px rgba(0,0,0,0.18);
      font-family:Segoe UI,sans-serif; font-size:13px;
      width:260px; overflow:hidden;
    `;
    dialog.addEventListener("click", (e) => e.stopPropagation());

    const header = doc.createElement("div");
    header.style.cssText = `
      background:#2b579a; color:#fff;
      padding:10px 16px; font-weight:600; font-size:13px;
    `;
    header.textContent = opts.title;
    dialog.appendChild(header);

    const body = doc.createElement("div");
    body.style.cssText = "padding:12px 16px; display:flex; flex-direction:column; gap:10px;";

    const inputStyle = `
      padding:6px 8px; border:1px solid #ccc; border-radius:4px;
      font-size:13px; font-family:Segoe UI,sans-serif;
    `;

    const makeFieldRow = (labelText: string): HTMLElement => {
      const row = doc.createElement("label");
      row.style.cssText = "display:flex; flex-direction:column; gap:3px; font-size:12px; color:#555;";
      const span = doc.createElement("span");
      span.textContent = labelText;
      row.appendChild(span);
      return row;
    };

    const labelRow = makeFieldRow("Label");
    const labelInput = doc.createElement("input");
    labelInput.type = "text";
    labelInput.value = opts.initial.label;
    labelInput.style.cssText = inputStyle;
    labelRow.appendChild(labelInput);
    body.appendChild(labelRow);

    const genderRow = makeFieldRow("Gender");
    const genderInput = doc.createElement("select");
    genderInput.style.cssText = inputStyle;
    for (const opt of MatsOverlay.MATGENDER_OPTIONS) {
      const optionEl = doc.createElement("option");
      optionEl.value = opt;
      optionEl.textContent = opt;
      if (opt === opts.initial.gender) optionEl.selected = true;
      genderInput.appendChild(optionEl);
    }
    genderRow.appendChild(genderInput);
    body.appendChild(genderRow);

    const numberGrid = doc.createElement("div");
    numberGrid.style.cssText = "display:grid; grid-template-columns:1fr 1fr; gap:8px;";

    const makeNumberField = (labelText: string, value: number): HTMLInputElement => {
      const row = makeFieldRow(labelText);
      const input = doc.createElement("input");
      input.type = "number";
      input.value = String(value);
      input.style.cssText = inputStyle;
      row.appendChild(input);
      numberGrid.appendChild(row);
      return input;
    };

    const widthInput  = makeNumberField("Width",      opts.initial.width);
    const heightInput = makeNumberField("Height",     opts.initial.height);
    const xInput       = makeNumberField("X Position", opts.initial.x);
    const yInput       = makeNumberField("Y Position", opts.initial.y);

    body.appendChild(numberGrid);
    dialog.appendChild(body);

    const errorMsg = doc.createElement("div");
    errorMsg.style.cssText = "padding:0 16px 10px; color:#c00; font-size:12px; display:none;";
    dialog.appendChild(errorMsg);

    const footer = doc.createElement("div");
    footer.style.cssText = "display:flex; justify-content:flex-end; gap:8px; padding:10px 16px; border-top:1px solid #eee;";

    const cancelBtn = doc.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "Cancel";
    cancelBtn.style.cssText = "padding:6px 12px; border:1px solid #ccc; border-radius:4px; background:#fff; cursor:pointer; font-size:13px;";
    cancelBtn.addEventListener("click", () => this.dismissMatFormDialog());

    const saveBtn = doc.createElement("button");
    saveBtn.type = "button";
    saveBtn.textContent = opts.saveLabel;
    saveBtn.style.cssText = "padding:6px 12px; border:none; border-radius:4px; background:#2b579a; color:#fff; cursor:pointer; font-size:13px;";
    saveBtn.addEventListener("click", () => {
      const label  = labelInput.value.trim();
      const width  = Number(widthInput.value);
      const height = Number(heightInput.value);
      const x      = Number(xInput.value);
      const y      = Number(yInput.value);
      const gender = genderInput.value;

      if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
        errorMsg.textContent = "Width and height must be positive numbers.";
        errorMsg.style.display = "block";
        return;
      }
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        errorMsg.textContent = "X and Y position must be numbers.";
        errorMsg.style.display = "block";
        return;
      }

      errorMsg.style.display = "none";
      saveBtn.disabled = true;
      cancelBtn.disabled = true;
      opts.onSave({ label, width, height, x, y, gender })
        .then(() => this.dismissMatFormDialog())
        .catch((err: unknown) => {
          console.error("[MatsOverlay] mat form save error:", err);
          errorMsg.textContent = err instanceof Error ? err.message : "Save failed.";
          errorMsg.style.display = "block";
          saveBtn.disabled = false;
          cancelBtn.disabled = false;
        });
    });

    footer.appendChild(cancelBtn);
    footer.appendChild(saveBtn);
    dialog.appendChild(footer);

    doc.body.appendChild(backdrop);
    doc.body.appendChild(dialog);

    // Nudge inside viewport if it overflows
    const r = dialog.getBoundingClientRect();
    if (r.right  > window.innerWidth)  dialog.style.left = `${opts.clientX - r.width  - 4}px`;
    if (r.bottom > window.innerHeight) dialog.style.top  = `${opts.clientY - r.height - 4}px`;
  }

  // ── Create / update mat records ──────────────────────────────────────────────

  /**
   * Resolves the current Mat Plan record from the host page via
   * Xrm.Utility.getPageContext() (Unified Interface only). This control has
   * no bound entityId/entityName input property, so this is the only way to
   * learn which Mat Plan a newly-created mat belongs to.
   */
  private async getCurrentMatPlanRef(): Promise<{ id: Guid; entityName: string }> {
    const xrm = this.getXrm();
    const input = xrm.Utility.getPageContext()?.input;
    if (!input?.entityId || !input.entityName) {
      throw new Error("Could not resolve the current Mat Plan record from the page context.");
    }
    return { id: input.entityId.replace(/[{}]/g, ""), entityName: input.entityName };
  }

  private async createMat(values: {
    label: string; width: number; height: number; x: number; y: number; gender: string;
  }): Promise<void> {
    const matPlan = await this.getCurrentMatPlanRef();

    const payload: Record<string, string | number | null> = {
      cp_matlabel:  values.label || null,
      cp_matwidth:  values.width,
      cp_matheight: values.height,
      cp_xposition: values.x,
      cp_yposition: values.y,
      cp_matgender: values.gender,
      [`${MatsOverlay.NAV_MATPLAN}@odata.bind`]: `/${MatsOverlay.SET_MATPLAN}(${matPlan.id})`,
    };

    console.log("[MatsOverlay] CREATE cp_mat:", JSON.stringify(payload));

    await this.context.webAPI.createRecord("cp_mat", payload);
    await this.showAlert(`✅ ${values.label || "Mat"}: created.`);
    await this.context.parameters.cp_mat.refresh();
  }

  private async updateMatProperties(mat: MatRow, values: {
    label: string; width: number; height: number; x: number; y: number; gender: string;
  }): Promise<void> {
    const payload: Record<string, string | number | null> = {
      cp_matlabel:  values.label || null,
      cp_matwidth:  values.width,
      cp_matheight: values.height,
      cp_xposition: values.x,
      cp_yposition: values.y,
      cp_matgender: values.gender,
    };

    console.log(`[MatsOverlay] PATCH cp_mat/${mat.id} (properties):`, JSON.stringify(payload));

    await this.context.webAPI.updateRecord("cp_mat", mat.id, payload);
    await this.showAlert(`✅ ${values.label || "Mat"}: properties updated.`);
    await this.context.parameters.cp_mat.refresh();
  }

  // ── Remove fields ─────────────────────────────────────────────────────────────

  private async removeFields(
    mat: MatRow,
    removeCheckin: boolean,
    removeClient: boolean
  ): Promise<void> {
    const matLabel = mat.cp_matlabel ?? (mat.cp_matnumber != null ? `Mat ${mat.cp_matnumber}` : mat.id);
    const payload: Record<string, null> = {};

    if (removeCheckin) payload[`${MatsOverlay.NAV_CHECKIN}@odata.bind`] = null;
    if (removeClient)  payload[`${MatsOverlay.NAV_CLIENT}@odata.bind`]  = null;

    console.log(`[MatsOverlay] Clearing from ${matLabel}:`, JSON.stringify(payload));

    await this.context.webAPI.updateRecord("cp_mat", mat.id, payload);

    if (removeCheckin && removeClient && mat.checkinId) {
      try {
        await this.context.webAPI.updateRecord("cp_sheltercheckin", mat.checkinId, {
          cp_removedfrommat:    true,
          cp_timeremovedfrommat: new Date().toISOString(),
        });
      } catch (err) {
        console.error("[MatsOverlay] Could not record removal time on check-in:", err);
      }
    }

    const what = removeCheckin && removeClient
      ? "Check-in & client removed."
      : removeCheckin ? "Check-in removed." : "Client removed.";

    await this.showAlert(`✅ ${matLabel}: ${what}`);
    await this.context.parameters.cp_mat.refresh();
  }

  // ── Complete Breathing Round ─────────────────────────────────────────────────

  private async completeBreathingRound(mat: MatRow): Promise<void> {
    const matLabel = mat.cp_matlabel ?? (mat.cp_matnumber != null ? `Mat ${mat.cp_matnumber}` : mat.id);

    let checkinId: Guid;
    try {
      const matRecord = await this.context.webAPI.retrieveRecord(
        "cp_mat",
        mat.id,
        "?$select=_cp_sheltercheckin_value"
      );
      const raw = matRecord["_cp_sheltercheckin_value"] as string | null | undefined;
      if (!raw) {
        await this.showAlert(`⚠️ ${matLabel}: No check-in assigned.`);
        return;
      }
      checkinId = raw.replace(/[{}]/g, "");
    } catch (err) {
      console.error("[MatsOverlay] Could not resolve check-in for breathing round:", err);
      await this.showAlert(`❌ ${matLabel}: Could not resolve check-in record.`);
      return;
    }

    const currentUserId = this.context.userSettings.userId.replace(/[{}]/g, "");

    await this.context.webAPI.updateRecord("cp_sheltercheckin", checkinId, {
      cp_breathinground: true,
      [`${MatsOverlay.NAV_BREATHING_ROUND_MODIFIED_BY}@odata.bind`]:
        `/${MatsOverlay.SET_SYSTEMUSER}(${currentUserId})`,
      cp_breathingroundmodifiedon: new Date().toISOString(),
    });
    this.breathingRoundById.set(checkinId.toLowerCase(), true);

    await this.showAlert(`✅ ${matLabel}: Breathing round completed.`);
    await this.context.parameters.cp_mat.refresh();
  }

  // ── Breathing round status cache ─────────────────────────────────────────────

  /**
   * Batches a single query for the cp_breathinground status of all active check-ins,
   * rather than one WebAPI call per mat. Throttled since updateView can fire on
   * every pan/zoom tick; re-renders once if the fetched statuses actually changed.
   */
  private async refreshBreathingRoundIndicators(): Promise<void> {
    const now = Date.now();
    if (this.breathingRoundFetchInFlight || now - this.breathingRoundLastFetch < 2000) return;
    this.breathingRoundFetchInFlight = true;

    try {
      const result = await this.context.webAPI.retrieveMultipleRecords(
        "cp_sheltercheckin",
        "?$select=cp_breathinground&$filter=statecode eq 0"
      );

      const next = new Map<string, boolean>();
      for (const rec of result.entities) {
        const id = (rec["cp_sheltercheckinid"] as string | undefined)?.toLowerCase();
        if (!id) continue;
        next.set(id, rec["cp_breathinground"] === true);
      }
      this.breathingRoundLastFetch = Date.now();

      let changed = next.size !== this.breathingRoundById.size;
      if (!changed) {
        for (const [id, val] of next) {
          if (this.breathingRoundById.get(id) !== val) { changed = true; break; }
        }
      }
      this.breathingRoundById = next;
      if (changed) this.updateView(this.context);
    } catch (err) {
      console.error("[MatsOverlay] Could not load breathing round status:", err);
    } finally {
      this.breathingRoundFetchInFlight = false;
    }
  }

  // ── Pick & Assign (unchanged) ─────────────────────────────────────────────────

  private async pickAndAssign(mat: MatRow): Promise<void> {
    const xrm      = this.getXrm();
    const matLabel = mat.cp_matlabel ?? (mat.cp_matnumber != null ? `Mat ${mat.cp_matnumber}` : mat.id);

    let scPick: LookupResult[];
    try {
      scPick = await xrm.Utility.lookupObjects({
        entityTypes:      ["cp_sheltercheckin"],
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
      return;
    }
    if (!scPick || scPick.length === 0) return;

    const shelterCheckinId: Guid = scPick[0].id.replace(/[{}]/g, "");

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

    const payload: Record<string, string | null> = {
      [`${MatsOverlay.NAV_CHECKIN}@odata.bind`]:
        `/${MatsOverlay.SET_CHECKIN}(${shelterCheckinId})`,
      [`${MatsOverlay.NAV_CLIENT}@odata.bind`]:
        contactId ? `/${MatsOverlay.SET_CONTACT}(${contactId})` : null,
    };

    console.log(`[MatsOverlay] PATCH cp_mat/${mat.id}:`, JSON.stringify(payload));

    await this.context.webAPI.updateRecord("cp_mat", mat.id, payload);

    try {
      await this.context.webAPI.updateRecord("cp_sheltercheckin", shelterCheckinId, {
        cp_assignedtomat:    true,
        cp_timeassignedtomat: new Date().toISOString(),
      });
    } catch (err) {
      console.error("[MatsOverlay] Could not record assignment time on check-in:", err);
    }

    const clientMsg = contactId
      ? "Check-in & client assigned."
      : "Check-in assigned (no client linked to this check-in).";
    await this.showAlert(`✅ ${matLabel}: ${clientMsg}`);
    await this.context.parameters.cp_mat.refresh();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

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
    this.dismissAllDialogs();
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
      const cp_matgender   = this.getString(rec, "cp_matgender");

      // Detect whether a check-in is already assigned.
      // The dataset exposes lookup fields as the formatted value string when bound,
      // or we can check the raw value of _cp_sheltercheckin_value.
      // Try both the property-set name and the underlying _value column.
      const checkinRaw = rec.getValue("cp_sheltercheckin");
      const hasCheckin = checkinRaw != null && checkinRaw !== "";

      let checkinId: string | null = null;
      if (checkinRaw && typeof checkinRaw === "object" && "id" in checkinRaw) {
        checkinId = (checkinRaw as ComponentFramework.EntityReference).id.guid
          .replace(/[{}]/g, "")
          .toLowerCase();
      }

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
        cp_matgender,
        hasCheckin,
        checkinId,
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