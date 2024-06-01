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
