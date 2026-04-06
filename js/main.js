const form = document.getElementById("setup-form");
const datasetSelect = document.getElementById("dataset-select");
const msg = document.getElementById("entry-message");

async function loadCatalog() {
  try {
    const res = await fetch("data/catalog.json", { cache: "no-store" });
    if (!res.ok) {
      throw new Error(`Failed to load catalog.json: ${res.status}`);
    }
    const catalog = await res.json();
    datasetSelect.innerHTML = "";

    if (!Array.isArray(catalog) || catalog.length === 0) {
      datasetSelect.innerHTML = '<option value="">No dataset available</option>';
      return;
    }

    const defaultOption = document.createElement("option");
    defaultOption.value = "";
    defaultOption.textContent = "Select a dataset";
    datasetSelect.append(defaultOption);

    for (const ds of catalog) {
      const option = document.createElement("option");
      option.value = ds.dataset;
      option.textContent = `${ds.dataset} (${ds.count})`;
      option.dataset.file = ds.file;
      option.dataset.count = String(ds.count);
      datasetSelect.append(option);
    }
  } catch (err) {
    msg.textContent = err.message;
    datasetSelect.innerHTML = '<option value="">Load failed</option>';
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  msg.textContent = "";

  const formData = new FormData(form);
  const annotatorName = String(formData.get("annotatorName") || "").trim();
  const dataset = String(formData.get("dataset") || "").trim();
  const annotationCount = Number(formData.get("annotationCount"));
  const startIndex = Number(formData.get("startIndex"));
  const selectedTiersRaw = formData.getAll("tier").map((x) => String(x));
  const selectedTiers = selectedTiersRaw.filter((x) => x === "T3" || x === "T4");

  if (!annotatorName) {
    msg.textContent = "Please enter annotator name.";
    return;
  }

  const selectedOption = datasetSelect.options[datasetSelect.selectedIndex];
  if (!dataset || !selectedOption || !selectedOption.dataset.file) {
    msg.textContent = "Please select a valid dataset.";
    return;
  }

  const maxCount = Number(selectedOption.dataset.count || 0);
  if (!Number.isFinite(annotationCount) || annotationCount < 1) {
    msg.textContent = "Number of items must be a positive integer.";
    return;
  }
  if (!Number.isFinite(startIndex) || startIndex < 1) {
    msg.textContent = "Start index must be a positive integer (1-based).";
    return;
  }
  if (selectedTiers.length === 0) {
    msg.textContent = "Please select at least one tier (T3 or T4).";
    return;
  }

  const finalCount = Math.min(Math.floor(annotationCount), maxCount || annotationCount);

  const config = {
    annotatorName,
    dataset,
    datasetFile: selectedOption.dataset.file,
    annotationCount: finalCount,
    requestedCount: Math.floor(annotationCount),
    startIndex: Math.floor(startIndex),
    selectedTiers,
    startedAt: new Date().toISOString(),
  };

  sessionStorage.setItem("annotationConfig", JSON.stringify(config));
  window.location.href = "annotate.html";
});

loadCatalog();
