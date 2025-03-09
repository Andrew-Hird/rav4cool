document.addEventListener("pointerdown", function () {
  const audio = document.getElementById("jingle");
  audio.play();
  document.removeEventListener("click", arguments.callee);
});

const imageContainer = document.querySelector(".ravs");
const images = imageContainer.querySelectorAll("img");
for (let i = 2; i < images.length; i++) {
  images[i].setAttribute("loading", "lazy");
}

// date overlay
document.addEventListener("DOMContentLoaded", function () {
  const images = document.querySelectorAll(".ravs img");

  images.forEach((img) => {
    // Create a wrapper div for each image
    const wrapper = document.createElement("div");
    wrapper.classList.add("image-wrapper");

    // Move the image inside the wrapper
    img.parentNode.insertBefore(wrapper, img);
    wrapper.appendChild(img);

    // Extract the filename from the image source
    const filePath = img.src;
    const fileName = filePath.split('/').pop();
    const dateMatch = fileName.match(/\d{8}/); // Match 8-digit date pattern

    // Add the overlay div for the date
    const dateOverlay = document.createElement("div");
    dateOverlay.classList.add("date-overlay");

    if (dateMatch) {
      const rawDate = dateMatch[0];

      // Format the date (e.g., 20250126 -> 26 Jan 2025)
      const year = rawDate.slice(0, 4);
      const month = rawDate.slice(4, 6);
      const day = rawDate.slice(6, 8);

      const date = new Date(`${year}-${month}-${day}`);
      const options = { day: "2-digit", month: "short", year: "numeric" };
      const formattedDate = date.toLocaleDateString("en-US", options);

      // Set the formatted date
      dateOverlay.textContent = formattedDate;
      wrapper.appendChild(dateOverlay);
    }
  });
});