import { IInputs, IOutputs } from "./generated/ManifestTypes";

type Guid = string;

/**
 * One stay: a Detox admission, a Boreal intake or a Shelter check-in.
 * Rows come from the three stay tables directly, not from a dataset, because a
 * client's stays live in three separate tables with no shared parent.
 */
interface StayRow {
  id: Guid;
  entity: string;
  programme: string;
  serviceType: string;
  name: string;
  start: Date | null;
  end: Date | null;
}

/**
 * Service Type is fixed per programme -- a stay in a given programme is always
 * the same kind of service. Values match the cp_servicetype global choice;
 * Detox and Transitional Housing are not options on that choice yet, so these
 * are display labels only.
 */
const SERVICE_TYPE_BY_PROGRAMME: Record<string, { label: string; value: number }> = {
  Detox: { label: "Detox", value: 121570003 },
  Shelter: { label: "Emergency Shelter", value: 121570002 },
  Boreal: { label: "Transitional Housing", value: 121570004 },
};

/** How each stay table maps onto the grid's start/end columns. */
const STAY_SOURCES = [
  {
    entity: "cp_cp_admission",
    idField: "cp_cp_admissionid",
    nameField: "cp_name",
    startField: "cp_admissiondate",
    endField: "cp_actualdischargedate",
    clientField: "_cp_client_value",
    programme: "Detox",
  },
  {
    entity: "ahb_intake",
    idField: "ahb_intakeid",
    nameField: "ahb_name",
    startField: "ahb_dateofintake",
    endField: "ahb_programexitdate",
    clientField: "_ahb_client_value",
    programme: "Boreal",
  },
  {
    entity: "cp_sheltercheckin",
    idField: "cp_sheltercheckinid",
    nameField: "cp_sheltercheckin",
    startField: "cp_checkindate",
    endField: "cp_checkoutdate",
    clientField: "_cp_client_value",
    programme: "Shelter",
  },
];

const DATE_PRESETS: { label: string; days: number | null }[] = [
  { label: "-Select-", days: null },
  { label: "Last 7 days", days: 7 },
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
  { label: "Last year", days: 365 },
];

interface PageContextInput {
  pageType: string;
  entityName?: string;
  entityId?: string;
}
interface XrmLike {
  Utility: { getPageContext(): { input?: PageContextInput } };
  Navigation: {
    openForm(opts: { entityName: string; entityId?: string }): Promise<unknown>;
  };
}

export class ServiceTransactions
  implements ComponentFramework.StandardControl<IInputs, IOutputs>
{
  private context: ComponentFramework.Context<IInputs>;
  private container: HTMLDivElement;

  private stays: StayRow[] = [];
  private loadErrors: string[] = [];
  private loaded = false;
  private loading = false;
  private clientId: Guid | null = null;

  private filterStart: Date | null = null;
  private filterEnd: Date | null = null;
  private pageIndex = 0;

  public init(
    context: ComponentFramework.Context<IInputs>,
    _notifyOutputChanged: () => void,
    _state: ComponentFramework.Dictionary,
    container: HTMLDivElement
  ): void {
    this.context = context;
    this.container = container;
    context.mode.trackContainerResize(true);
  }

  public updateView(context: ComponentFramework.Context<IInputs>): void {
    this.context = context;
    if (!this.loaded && !this.loading) {
      this.loading = true;
      this.render();
      void this.loadStays().finally(() => {
        this.loading = false;
        this.loaded = true;
        this.render();
      });
      return;
    }
    this.render();
  }

  public getOutputs(): IOutputs {
    return {};
  }

  public destroy(): void {
    this.container.innerHTML = "";
  }

  // ── Data ──────────────────────────────────────────────────────────────────

  /** The client whose form this control sits on. */
  private resolveClientId(): Guid | null {
    try {
      const input = this.getXrm().Utility.getPageContext()?.input;
      if (input?.entityName === "contact" && input.entityId) {
        return input.entityId.replace(/[{}]/g, "").toLowerCase();
      }
    } catch (err) {
      console.warn("[ServiceTransactions] Could not read the page context:", err);
    }
    return null;
  }

  private async loadStays(): Promise<void> {
    this.stays = [];
    this.loadErrors = [];
    this.clientId = this.resolveClientId();
    if (!this.clientId) return;

    // Each table is queried independently so that one failure -- most likely a
    // user without read access to another programme's table -- still leaves the
    // other stays visible, with a note about what is missing.
    const results = await Promise.all(
      STAY_SOURCES.map(async (src) => {
        const query =
          `?$select=${src.idField},${src.nameField},${src.startField},${src.endField}` +
          `&$filter=${src.clientField} eq ${this.clientId}`;
        try {
          const res = await this.context.webAPI.retrieveMultipleRecords(src.entity, query);
          return res.entities.map((e): StayRow => ({
            id: String(e[src.idField] ?? "").replace(/[{}]/g, ""),
            entity: src.entity,
            programme: src.programme,
            serviceType: SERVICE_TYPE_BY_PROGRAMME[src.programme]?.label ?? "",
            name: (e[src.nameField] as string | null) ?? "",
            start: e[src.startField] ? new Date(e[src.startField] as string) : null,
            end: e[src.endField] ? new Date(e[src.endField] as string) : null,
          }));
        } catch (err) {
          console.error(`[ServiceTransactions] Could not read ${src.entity}:`, err);
          this.loadErrors.push(src.programme);
          return [] as StayRow[];
        }
      })
    );

    this.stays = results
      .flat()
      .sort((a, b) => (b.start?.getTime() ?? 0) - (a.start?.getTime() ?? 0));
  }

  private applyFilter(rows: StayRow[]): StayRow[] {
    if (!this.filterStart && !this.filterEnd) return rows;
    return rows.filter((r) => {
      if (!r.start) return false;
      if (this.filterStart && r.start < this.filterStart) return false;
      if (this.filterEnd && r.start > this.filterEnd) return false;
      return true;
    });
  }

  private rowsPerPage(): number {
    const configured = this.context.parameters.RowsPerPage?.raw;
    return configured && configured > 0 ? configured : 10;
  }

  // ── Render ────────────────────────────────────────────────────────────────

  private render(): void {
    const doc = this.container.ownerDocument;
    const rows = this.applyFilter(this.stays);
    const perPage = this.rowsPerPage();
    const pageCount = Math.max(1, Math.ceil(rows.length / perPage));
    if (this.pageIndex > pageCount - 1) this.pageIndex = pageCount - 1;
    if (this.pageIndex < 0) this.pageIndex = 0;
    const from = this.pageIndex * perPage;
    const pageRows = rows.slice(from, from + perPage);

    this.container.innerHTML = "";
    const panel = doc.createElement("div");
    panel.style.cssText =
      "font-family:Segoe UI,sans-serif;font-size:13px;color:#201f1e;border:1px solid #d0d0d0;border-radius:4px;overflow:hidden;background:#fff;";

    panel.appendChild(this.buildHeader(doc));
    panel.appendChild(this.buildFilterBar(doc));
    if (this.loadErrors.length) panel.appendChild(this.buildWarning(doc));
    panel.appendChild(this.buildTable(doc, pageRows));
    panel.appendChild(this.buildFooter(doc, rows.length, from, pageRows.length, pageCount));
    this.container.appendChild(panel);
  }

  private buildHeader(doc: Document): HTMLElement {
    const header = doc.createElement("div");
    header.style.cssText = "padding:10px 14px;font-weight:600;font-size:14px;border-bottom:3px solid #6b2fa0;";
    header.textContent = this.context.parameters.Title?.raw || "Previous Stays";
    return header;
  }

  private buildWarning(doc: Document): HTMLElement {
    const note = doc.createElement("div");
    note.style.cssText = "padding:8px 14px;background:#fff4ce;border-bottom:1px solid #e1dfdd;font-size:12px;";
    note.textContent = `Could not load ${this.loadErrors.join(" and ")} stays. Other programmes are shown.`;
    return note;
  }

  private buildFilterBar(doc: Document): HTMLElement {
    const bar = doc.createElement("div");
    bar.style.cssText =
      "display:flex;flex-wrap:wrap;align-items:flex-end;gap:14px;padding:10px 14px;background:#faf9f8;border-bottom:1px solid #e1dfdd;";

    const field = (labelText: string): HTMLElement => {
      const wrap = doc.createElement("label");
      wrap.style.cssText = "display:flex;flex-direction:column;gap:3px;font-size:12px;color:#605e5c;";
      const span = doc.createElement("span");
      span.textContent = labelText;
      wrap.appendChild(span);
      return wrap;
    };
    const inputCss =
      "padding:5px 7px;border:1px solid #8a8886;border-radius:2px;font-size:13px;font-family:inherit;";

    const presetWrap = field("Select Dates");
    const preset = doc.createElement("select");
    preset.style.cssText = inputCss;
    for (const p of DATE_PRESETS) {
      const opt = doc.createElement("option");
      opt.value = String(p.days ?? "");
      opt.textContent = p.label;
      preset.appendChild(opt);
    }
    presetWrap.appendChild(preset);

    const startWrap = field("Start Date");
    const startInput = doc.createElement("input");
    startInput.type = "date";
    startInput.style.cssText = inputCss;
    if (this.filterStart) startInput.value = ServiceTransactions.toInputDate(this.filterStart);
    startWrap.appendChild(startInput);

    const endWrap = field("End Date");
    const endInput = doc.createElement("input");
    endInput.type = "date";
    endInput.style.cssText = inputCss;
    if (this.filterEnd) endInput.value = ServiceTransactions.toInputDate(this.filterEnd);
    endWrap.appendChild(endInput);

    preset.addEventListener("change", () => {
      const days = preset.value ? Number(preset.value) : null;
      if (!days) return;
      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - days);
      startInput.value = ServiceTransactions.toInputDate(start);
      endInput.value = ServiceTransactions.toInputDate(end);
    });

    const button = (text: string, onClick: () => void): HTMLButtonElement => {
      const b = doc.createElement("button");
      b.type = "button";
      b.textContent = text;
      b.style.cssText =
        "padding:6px 16px;border:1px solid #8a8886;border-radius:2px;background:#fff;cursor:pointer;font-size:13px;";
      b.addEventListener("click", onClick);
      return b;
    };

    bar.appendChild(presetWrap);
    bar.appendChild(startWrap);
    bar.appendChild(endWrap);
    bar.appendChild(
      button("Search", () => {
        this.filterStart = startInput.value ? ServiceTransactions.startOfDay(startInput.value) : null;
        this.filterEnd = endInput.value ? ServiceTransactions.endOfDay(endInput.value) : null;
        this.pageIndex = 0;
        this.render();
      })
    );
    bar.appendChild(
      button("Clear", () => {
        this.filterStart = null;
        this.filterEnd = null;
        this.pageIndex = 0;
        this.render();
      })
    );
    return bar;
  }

  private buildTable(doc: Document, pageRows: StayRow[]): HTMLElement {
    const wrap = doc.createElement("div");
    wrap.style.cssText = "overflow-x:auto;";
    const table = doc.createElement("table");
    table.style.cssText = "width:100%;border-collapse:collapse;";

    const headers = ["", "Start Date", "End Date", "Provider of Service", "Service Type", "Stay"];
    const thead = doc.createElement("thead");
    const headRow = doc.createElement("tr");
    for (const h of headers) {
      const th = doc.createElement("th");
      th.textContent = h;
      th.style.cssText =
        "text-align:left;padding:8px 10px;background:#f3f2f1;border-bottom:1px solid #d0d0d0;font-weight:600;white-space:nowrap;";
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = doc.createElement("tbody");
    if (pageRows.length === 0) {
      const tr = doc.createElement("tr");
      const td = doc.createElement("td");
      td.colSpan = headers.length;
      td.textContent = this.loading
        ? "Loading stays..."
        : this.clientId
          ? "No stays to show."
          : "Open a client record to see their stays.";
      td.style.cssText = "padding:16px;color:#605e5c;text-align:center;";
      tr.appendChild(td);
      tbody.appendChild(tr);
    }

    for (const row of pageRows) {
      const tr = doc.createElement("tr");
      tr.style.cssText = "border-bottom:1px solid #edebe9;";
      tr.addEventListener("mouseenter", () => { tr.style.background = "#f3f2f1"; });
      tr.addEventListener("mouseleave", () => { tr.style.background = "#fff"; });

      const iconTd = doc.createElement("td");
      iconTd.style.cssText = "padding:6px 4px;width:30px;text-align:center;";
      const open = doc.createElement("button");
      open.type = "button";
      open.title = `Open this ${row.programme} stay`;
      open.setAttribute("aria-label", `Open this ${row.programme} stay`);
      open.textContent = "✏️";
      open.style.cssText = "border:none;background:transparent;cursor:pointer;font-size:14px;padding:2px;";
      open.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.openStay(row);
      });
      iconTd.appendChild(open);
      tr.appendChild(iconTd);

      const cells = [
        ServiceTransactions.formatDate(row.start),
        ServiceTransactions.formatDate(row.end),
        row.programme,
        row.serviceType,
        row.name,
      ];
      for (const text of cells) {
        const td = doc.createElement("td");
        td.textContent = text;
        td.style.cssText = "padding:8px 10px;white-space:nowrap;";
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  private buildFooter(
    doc: Document,
    total: number,
    from: number,
    shown: number,
    pageCount: number
  ): HTMLElement {
    const footer = doc.createElement("div");
    footer.style.cssText =
      "display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;border-top:1px solid #e1dfdd;background:#faf9f8;flex-wrap:wrap;";

    const left = doc.createElement("div");
    const counts = doc.createElement("span");
    counts.style.cssText = "font-size:12px;color:#605e5c;";
    const byProgramme = STAY_SOURCES.map(
      (s) => `${s.programme}: ${this.stays.filter((r) => r.programme === s.programme).length}`
    ).join("   ");
    counts.textContent = byProgramme;
    left.appendChild(counts);

    const middle = doc.createElement("div");
    middle.style.cssText = "font-size:12px;color:#605e5c;";
    middle.textContent =
      total === 0 ? "Showing 0 of 0" : `Showing ${from + 1}-${from + shown} of ${total}`;

    const right = doc.createElement("div");
    right.style.cssText = "display:flex;gap:6px;";
    const nav = (labelText: string, target: number, enabled: boolean): void => {
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.textContent = labelText;
      btn.disabled = !enabled;
      btn.style.cssText =
        "padding:5px 12px;border:1px solid #8a8886;border-radius:2px;background:#fff;font-size:12px;" +
        (enabled ? "cursor:pointer;" : "cursor:default;opacity:0.5;");
      btn.addEventListener("click", () => {
        this.pageIndex = target;
        this.render();
      });
      right.appendChild(btn);
    };
    const back = this.pageIndex > 0;
    const forward = this.pageIndex < pageCount - 1;
    nav("First", 0, back);
    nav("Previous", this.pageIndex - 1, back);
    nav("Next", this.pageIndex + 1, forward);
    nav("Last", pageCount - 1, forward);

    footer.appendChild(left);
    footer.appendChild(middle);
    footer.appendChild(right);
    return footer;
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  private async openStay(row: StayRow): Promise<void> {
    try {
      await this.getXrm().Navigation.openForm({ entityName: row.entity, entityId: row.id });
      this.loaded = false; // values may have changed while the form was open
      this.updateView(this.context);
    } catch (err) {
      console.error("[ServiceTransactions] Could not open the stay:", err);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private getXrm(): XrmLike {
    const w = window as unknown as { Xrm?: XrmLike; parent?: { Xrm?: XrmLike } };
    const xrm = w.Xrm ?? w.parent?.Xrm;
    if (!xrm) throw new Error("Xrm is not available (Unified Interface only).");
    return xrm;
  }

  private static formatDate(d: Date | null): string {
    return d ? d.toLocaleDateString() : "";
  }

  private static toInputDate(d: Date): string {
    const pad = (n: number): string => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  private static startOfDay(value: string): Date {
    return new Date(`${value}T00:00:00`);
  }

  private static endOfDay(value: string): Date {
    return new Date(`${value}T23:59:59.999`);
  }
}
