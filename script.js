document.addEventListener("pointerdown", function onFirst() {
	document.getElementById("jingle").play();
	document.removeEventListener("pointerdown", onFirst);
});

async function loadGallery() {
	const res = await fetch("gallery.json");
	const { images } = await res.json();
	const container = document.querySelector(".ravs");

	images.forEach((filename, i) => {
		const img = document.createElement("img");
		img.src = `assets/ravs/${filename}`;
		img.alt = "RAV4";
		if (i >= 2) img.setAttribute("loading", "lazy");
		container.appendChild(img);
	});

	applyDateOverlays(container);
}

function applyDateOverlays(container) {
	container.querySelectorAll("img").forEach((img) => {
		const wrapper = document.createElement("div");
		wrapper.classList.add("image-wrapper");
		img.parentNode.insertBefore(wrapper, img);
		wrapper.appendChild(img);

		const fileName = img.src.split("/").pop();
		const dateMatch = fileName.match(/\d{8}/);
		if (dateMatch) {
			const raw = dateMatch[0];
			const date = new Date(
				`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`,
			);
			const overlay = document.createElement("div");
			overlay.classList.add("date-overlay");
			overlay.textContent = date.toLocaleDateString("en-US", {
				day: "2-digit",
				month: "short",
				year: "numeric",
			});
			wrapper.appendChild(overlay);
		}
	});
}

loadGallery();
