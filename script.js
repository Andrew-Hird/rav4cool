document.addEventListener("pointerdown", function () {
  const audio = document.getElementById("jingle");
  audio.play();
  document.removeEventListener("click", arguments.callee);
});
