// Images and the gallery manifest both live in R2, served from img.rav4.cool.
// Adding a photo is a bucket upload, not a deploy, so nothing here is baked in
// at build time.
const IMAGE_BASE = "https://img.rav4.cool";

document.addEventListener("pointerdown", function onFirst() {
	document.getElementById("jingle").play();
	document.removeEventListener("pointerdown", onFirst);
});

async function loadGallery() {
	const res = await fetch(`${IMAGE_BASE}/gallery.json`);
	if (!res.ok) throw new Error(`gallery.json: ${res.status}`);
	const { images } = await res.json();

	const container = document.querySelector(".ravs");
	const fragment = document.createDocumentFragment();
	images.forEach((image, i) => {
		fragment.appendChild(buildRav(image, i));
	});
	container.appendChild(fragment);
}

function buildRav(image, index) {
	const wrapper = document.createElement("div");
	wrapper.classList.add("image-wrapper");

	const img = document.createElement("img");
	img.src = `${IMAGE_BASE}/ravs/${image.file}`;
	img.alt = "RAV4";
	// Real per-image dimensions, so the grid reserves the right space instead of
	// reflowing as each photo arrives. Only Worker-processed photos are square,
	// so these must come from the manifest rather than being assumed.
	if (image.width && image.height) {
		img.width = image.width;
		img.height = image.height;
	}
	// The first two are above the fold on most screens.
	if (index >= 2) img.setAttribute("loading", "lazy");
	wrapper.appendChild(img);

	// date is null for photos with no date in the filename, which get no overlay.
	if (image.date) wrapper.appendChild(buildDateOverlay(image.date));

	return wrapper;
}

function buildDateOverlay(stamp) {
	const date = new Date(
		`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`,
	);
	const overlay = document.createElement("div");
	overlay.classList.add("date-overlay");
	overlay.textContent = date.toLocaleDateString("en-US", {
		day: "2-digit",
		month: "short",
		year: "numeric",
	});
	return overlay;
}

loadGallery();
