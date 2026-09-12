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



// Generalized handler: pass in the logical names of the boolean field and its
// corresponding date field. Attach this same function to both OnChange events
// with different bound parameters (see wiring examples below).
function handle_checkin_checkout_toggle(execution_context, bool_field_name, date_field_name) {
    var form_context = execution_context.getFormContext();

    var bool_attribute = form_context.getAttribute(bool_field_name);
    var date_attribute = form_context.getAttribute(date_field_name);

    if (!bool_attribute || !date_attribute) {
        console.warn("Missing attribute(s): " + bool_field_name + ", " + date_field_name);
        return;
    }

    var bool_value = bool_attribute.getValue();

    if (bool_value === true) {
        date_attribute.setValue(new Date());
    } else {
        date_attribute.setValue(null);
    }
}

// ---- Specific wrapper functions to register on the form's OnChange events ----
// Power Apps model-driven forms call OnChange handlers with just executionContext,
// so wrap the generalized function with the specific field names baked in.

function on_checkin_change(execution_context) {
    handle_checkin_checkout_toggle(execution_context, "cp_checkin", "cp_checkindate");
}

function on_checkout_change(execution_context) {
    handle_checkin_checkout_toggle(execution_context, "cp_checkout", "cp_checkoutdate");
}


//------------------------------------------------------------------------------------------------------------------------------------


/**
 * OnChange handler: when the Client lookup on cp_sheltercheckin changes,
 * fetch the related client, pull that client's latest alert, and surface
 * its description as a notification - but only if cp_markasread on that
 * alert is NOT true. Does NOT write any links - linking/cleanup happens
 * on save, in on_checkin_post_save.
 *
 * @param {object} execution_context   Form execution context
 * @param {string} field_name          Logical name of the client lookup attribute (default: "cp_client")
 */
async function handle_client_lookup_change(execution_context, field_name = "cp_client") {
    const form_context = execution_context.getFormContext();
    const client_attr = form_context.getAttribute(field_name);
    const notif_id = "client_alert_" + field_name;
    form_context.ui.clearFormNotification(notif_id);
    if (!client_attr) {
        console.warn("Client lookup attribute not found:", field_name);
        return;
    }
    const lookup_value = client_attr.getValue();
    if (!lookup_value || lookup_value.length === 0) {
        return;
    }
    const client_id = lookup_value[0].id.replace(/[{}]/g, "");
    const client_entity_type = lookup_value[0].entityType; // should be "contact"
    try {
        const client_record = await Xrm.WebApi.retrieveRecord(
            client_entity_type,
            client_id,
            "?$select=fullname"
        );
        const latest_alert = await get_latest_client_alert(client_id);
        // only notify when there is a latest alert, it has a description,
        // AND it has NOT been marked as read
        if (!latest_alert || !latest_alert.cp_alertdescription || latest_alert.cp_markasread === true) {
            return;
        }
        form_context.ui.setFormNotification(
            "Client alert: " + latest_alert.cp_alertdescription,
            "WARNING",
            notif_id
        );
        await Xrm.Navigation.openAlertDialog(
            {
                title: "Client Alert - " + (client_record.fullname || "Client"),
                text: latest_alert.cp_alertdescription
            },
            { width: 520 }
        );
    } catch (error) {
        console.error("Error retrieving client alert data:", error);
        form_context.ui.setFormNotification(
            "Unable to retrieve client alert information.",
            "ERROR",
            notif_id
        );
    }
}

/**
 * OnPostSave handler: runs after the cp_sheltercheckin record is committed
 * (so a real record id exists, even for brand-new records). Unlinks any
 * cp_clientalert records linked to this check-in whose client no longer
 * matches the current client, then links the current client's latest alert
 * to this check-in - but only if that alert's cp_markasread is NOT true.
 *
 * @param {object} execution_context   Form execution context
 * @param {string} field_name          Logical name of the client lookup attribute (default: "cp_client")
 */
async function on_checkin_post_save(execution_context, field_name = "cp_client") {
    const form_context = execution_context.getFormContext();
    const client_attr = form_context.getAttribute(field_name);
    const raw_checkin_id = form_context.data.entity.getId();
    const checkin_id = raw_checkin_id ? raw_checkin_id.replace(/[{}]/g, "") : null;
    if (!checkin_id) {
        console.warn("on_checkin_post_save: no record id available after save.");
        return;
    }
    const lookup_value = client_attr ? client_attr.getValue() : null;
    const current_client_id = (lookup_value && lookup_value.length > 0)
        ? lookup_value[0].id.replace(/[{}]/g, "")
        : null;
    // 1. Unlink (not delete) any linked alert whose client no longer matches
    await unlink_mismatched_client_alerts(checkin_id, current_client_id);
    // no client selected - nothing to link
    if (!current_client_id) {
        return;
    }
    // 2. Find the current client's latest alert and link it to this
    //    check-in, but only if it has NOT been marked as read
    const latest_alert = await get_latest_client_alert(current_client_id);
    if (latest_alert && latest_alert.cp_markasread !== true) {
        await link_alert_to_checkin(latest_alert.cp_clientalertid, checkin_id);
    }
}

/**
 * Retrieves the most recent cp_clientalert record for a given client.
 *
 * @param {string} client_id   GUID of the client (contact) record
 * @returns {object|null}      The latest alert record, or null if none exist
 */
async function get_latest_client_alert(client_id) {
    const alert_fetch_options =
        "?$select=cp_clientalertid,cp_alertdescription,createdon,cp_markasread" +
        "&$filter=_cp_client_value eq " + client_id +
        "&$orderby=createdon desc";
    const alert_results = await Xrm.WebApi.retrieveMultipleRecords(
        "cp_clientalert",
        alert_fetch_options
    );
    const alert_records = alert_results.entities;
    return (alert_records && alert_records.length > 0) ? alert_records[0] : null;
}

/**
 * Clears the cp_sheltercheckin lookup (does NOT delete the record) on any
 * cp_clientalert records currently linked to this check-in whose related
 * client does not match current_client_id. If current_client_id is null,
 * all linked alerts are considered mismatched and unlinked.
 *
 * @param {string} checkin_id              GUID of the current cp_sheltercheckin record
 * @param {string|null} current_client_id  GUID of the current client, or null
 */
async function unlink_mismatched_client_alerts(checkin_id, current_client_id) {
    try {
        const linked_fetch_options =
            "?$select=cp_clientalertid,_cp_client_value" +
            "&$filter=_cp_sheltercheckin_value eq " + checkin_id;
        const linked_results = await Xrm.WebApi.retrieveMultipleRecords(
            "cp_clientalert",
            linked_fetch_options
        );
        const linked_alerts = linked_results.entities;
        if (!linked_alerts || linked_alerts.length === 0) {
            return;
        }
        const unlink_promises = [];
        for (const alert of linked_alerts) {
            const alert_client_id = alert._cp_client_value
                ? alert._cp_client_value.replace(/[{}]/g, "")
                : null;
            const is_mismatch = !current_client_id || alert_client_id !== current_client_id;
            if (is_mismatch) {
                unlink_promises.push(
                    Xrm.WebApi.updateRecord("cp_clientalert", alert.cp_clientalertid, {
                        "cp_ShelterCheckin@odata.bind": null
                    })
                );
            }
        }
        if (unlink_promises.length > 0) {
            await Promise.all(unlink_promises);
        }
    } catch (error) {
        console.error("Error unlinking mismatched client alerts:", error);
    }
}

/**
 * Sets the cp_clientalert record's cp_sheltercheckin lookup to point at
 * the current check-in record.
 *
 * @param {string} alert_id     GUID of the cp_clientalert record
 * @param {string} checkin_id   GUID of the current cp_sheltercheckin record
 */
async function link_alert_to_checkin(alert_id, checkin_id) {
    try {
        await Xrm.WebApi.updateRecord("cp_clientalert", alert_id, {
            "cp_ShelterCheckin@odata.bind": "/cp_sheltercheckins(" + checkin_id + ")"
        });
    } catch (error) {
        console.error("Error linking alert to check-in:", error);
    }
}

/**
 * OnLoad handler: registers the post-save handler for this form.
 * Bind this to the form's On Load event.
 *
 * @param {object} execution_context   Form execution context
 */
function on_checkin_form_load(execution_context) {
    const form_context = execution_context.getFormContext();
    form_context.data.entity.addOnPostSave(on_checkin_saved);
}

/**
 * Thin named wrapper for OnPostSave binding, registered via addOnPostSave
 * in on_checkin_form_load. Do NOT bind this directly in the Events panel -
 * there is no Post Save slot in the classic form editor UI.
 */
function on_checkin_saved(execution_context) {
    on_checkin_post_save(execution_context, "cp_client");
}

/**
 * Thin named wrapper for OnChange binding on the client lookup field.
 * Bind this function (not the core handler) in the form's event handlers.
 */
function on_client_field_change(execution_context) {
    handle_client_lookup_change(execution_context, "cp_client");
}


//------------------------------------------------------------------------------------------------------------------------------------


/**
 * OnLoad handler for the contact (Client) form: fetches this client's
 * latest cp_clientalert record and shows a notification if it has NOT
 * been marked as read. Notification only - does not write or link any
 * records.
 *
 * @param {object} execution_context   Form execution context
 */
async function on_client_load(execution_context) {
    const form_context = execution_context.getFormContext();
    const notif_id = "client_alert_on_load";

    form_context.ui.clearFormNotification(notif_id);

    const raw_client_id = form_context.data.entity.getId();
    const client_id = raw_client_id ? raw_client_id.replace(/[{}]/g, "") : null;

    // new/unsaved contact record - nothing to look up yet
    if (!client_id) {
        return;
    }

    try {
        const latest_alert = await get_latest_client_alert(client_id);

        // only notify when there is a latest alert, it has a description,
        // AND it has NOT been marked as read
        if (!latest_alert || !latest_alert.cp_alertdescription || latest_alert.cp_markasread === true) {
            return;
        }

        const client_name = form_context.getAttribute("fullname")
            ? form_context.getAttribute("fullname").getValue()
            : "Client";

        form_context.ui.setFormNotification(
            "Client alert: " + latest_alert.cp_alertdescription,
            "WARNING",
            notif_id
        );

        await Xrm.Navigation.openAlertDialog(
            {
                title: "Client Alert - " + client_name,
                text: latest_alert.cp_alertdescription
            },
            { width: 520 }
        );

    } catch (error) {
        console.error("Error retrieving client alert data:", error);
        form_context.ui.setFormNotification(
            "Unable to retrieve client alert information.",
            "ERROR",
            notif_id
        );
    }
}
