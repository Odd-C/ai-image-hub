(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const layout = $("#admin-layout");
  const menuButton = $("#admin-menu-button");
  const scrim = $("#admin-scrim");

  function setDrawer(open) {
    if (!layout || !menuButton || !scrim) return;
    layout.classList.toggle("drawer-open", open);
    menuButton.setAttribute("aria-expanded", String(open));
    scrim.hidden = !open;
  }

  menuButton?.addEventListener("click", () => setDrawer(!layout.classList.contains("drawer-open")));
  scrim?.addEventListener("click", () => setDrawer(false));
  window.addEventListener("resize", () => {
    if (!matchMedia("(max-width: 768px)").matches) setDrawer(false);
  });

  function closeDialog(dialog) {
    dialog.close();
    dialog.querySelector("form")?.reset();
  }

  $$('[data-open-dialog]').forEach((button) => {
    button.addEventListener("click", () => {
      const dialog = document.getElementById(button.dataset.openDialog);
      if (dialog instanceof HTMLDialogElement) dialog.showModal();
      button.closest("details")?.removeAttribute("open");
    });
  });
  $$('dialog [data-close-dialog]').forEach((button) => {
    button.addEventListener("click", () => closeDialog(button.closest("dialog")));
  });
  $$("dialog.admin-dialog").forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) closeDialog(dialog);
    });
  });

  $$('[data-page-size]').forEach((select) => {
    select.addEventListener("change", () => {
      const url = new URL(window.location.href);
      url.searchParams.set("per_page", select.value);
      url.searchParams.set("page", "1");
      window.location.assign(url);
    });
  });

  const modelRows = $("#model-rows");
  const modelTemplate = $("#model-row-template");
  const providerForm = $("#provider-form");

  function addModelRow() {
    if (!modelRows || !modelTemplate) return;
    modelRows.append(modelTemplate.content.cloneNode(true));
    $(".model-row:last-child input", modelRows)?.focus();
  }

  $("#add-model-row")?.addEventListener("click", addModelRow);
  modelRows?.addEventListener("click", (event) => {
    const remove = event.target.closest(".remove-model-row");
    if (!remove) return;
    remove.closest(".model-row").remove();
    if (!$(".model-row", modelRows)) addModelRow();
  });

  providerForm?.addEventListener("submit", (event) => {
    const rows = $$(".model-row", modelRows);
    if (!rows.length) {
      event.preventDefault();
      addModelRow();
      return;
    }
    const serialized = [];
    let invalid = null;
    rows.forEach((row) => {
      $$('input', row).forEach((input) => input.setCustomValidity(""));
      const modelId = $('[data-field="model-id"]', row);
      const label = $('[data-field="label"]', row);
      const ratios = $$('[data-field="ratio"]:checked', row).map((item) => item.value);
      const resolutions = $$('[data-field="resolution"]:checked', row).map((item) => item.value);
      [modelId, label].forEach((input) => input.setCustomValidity(""));
      if (/[\s,|;]/.test(modelId.value)) {
        modelId.setCustomValidity("服务端模型 ID 不能包含空白、逗号、竖线或分号");
        invalid ||= modelId;
      }
      if (/[,|;]/.test(label.value)) {
        label.setCustomValidity("显示名称不能包含逗号、竖线或分号");
        invalid ||= label;
      }
      if (!ratios.length || !resolutions.length) {
        const target = !ratios.length ? $('[data-field="ratio"]', row) : $('[data-field="resolution"]', row);
        target.setCustomValidity(!ratios.length ? "至少选择一个比例" : "至少选择一个分辨率");
        invalid ||= target;
      }
      serialized.push([
        modelId.value.trim(),
        label.value.trim(),
        ratios.join(";"),
        resolutions.join(";"),
        $('[data-field="max-references"]', row).value,
        $('[data-field="enabled"]', row).checked ? "true" : "false",
        $('[data-field="quality"]', row).value,
      ].join("|"));
    });
    if (invalid) {
      event.preventDefault();
      invalid.reportValidity();
      invalid.focus();
      return;
    }
    $("#serialized-models").value = serialized.join(",");
  });

  if (modelRows && !$(".model-row", modelRows)) addModelRow();
})();
