// cp_/scripts/matsOverlay.form.js

var CpShelter = CpShelter || {};
CpShelter.MatsOverlayForm = (function () {
  // === Configure these to match your setup ===
  var PCF_CONTROL_NAME = "mat_plan_subgrid"; // <-- the subgrid name that hosts your PCF
  var OPEN_IN_SIDE_PANE = true;            // true: open in side pane; false: open main form
  var SIDE_PANE_WIDTH = 600;               // px, if opening in side pane

  /**
   * Form OnLoad handler
   * @param {Xrm.Events.EventContext} executionContext
   */
  function onLoad(executionContext) {
    var formContext = executionContext.getFormContext();

    // Get the control that hosts the dataset PCF
    var ctrl = formContext.getControl(PCF_CONTROL_NAME);
    if (!ctrl) {
      // Optional: surface a warning if the control isn't on this form
      console.warn("PCF control not found:", PCF_CONTROL_NAME);
      return;
    }

    // Subscribe to PCF output changes (SelectedId, ChangeKind, etc.)
    ctrl.addOnOutputChange(function (eCtx) {
      try {
        // The control instance is the same we subscribed on
        // getOutputs() returns the dictionary of output properties
        var outputs = ctrl.getOutputs && ctrl.getOutputs();
        if (!outputs) return;

        var selectedId = outputs.SelectedId;
        var changeKind = outputs.ChangeKind; // "select" | "move" | "resize" (from your PCF)

        // Only react to selection events
        if (!selectedId || (changeKind && changeKind !== "select")) return;

        if (OPEN_IN_SIDE_PANE) {
          openInSidePane(selectedId);
        } else {
          openMainForm(selectedId);
        }
      } catch (err) {
        console.error("OnOutputChange handler error:", err);
      }
    });
  }

  /**
   * Open the cp_mat record in the main form area
   * Uses Xrm.Navigation.openForm
   * https://learn.microsoft.com/en-us/power-apps/developer/model-driven-apps/clientapi/reference/xrm-navigation/openform
   */
  function openMainForm(matId) {
    Xrm.Navigation.openForm({
      entityName: "cp_mat",
      entityId: matId
      // Optional: openInNewWindow: true, formId: "GUID", etc.
    }).then(
      function () { /* no-op */ },
      function (error) { console.error("openForm error:", error); }
    );
  }

  /**
   * Open the cp_mat record in a side pane
   * Uses Xrm.App.sidePanes API
   * https://learn.microsoft.com/en-us/power-apps/developer/model-driven-apps/clientapi/create-app-side-panes
   */
  function openInSidePane(matId) {
    Xrm.App.sidePanes.createPane({
      title: "Mat details",
      canClose: true,
      width: SIDE_PANE_WIDTH
    }).then(function (pane) {
      pane.navigate({
        pageType: "entityrecord",
        entityName: "cp_mat",
        entityId: matId
      });
    }).catch(function (error) {
      console.error("createPane/navigate error:", error);
      // Fallback: open main form if side pane fails
      openMainForm(matId);
    });
  }

  // Public API
  return {
    onLoad: onLoad
  };
})();