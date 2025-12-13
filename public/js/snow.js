(function () {
  for (let i = 0; i < 32; i++) {
    const snow = document.createElement("div");
    snow.className = "snow";
    snow.style.left = Math.random() * 100 + "vw";
    snow.style.animationDuration = 10 + Math.random() * 10 + "s";
    snow.style.opacity = 0.4 + Math.random() * 0.6;
    snow.style.transform = `scale(${0.6 + Math.random()})`;
    document.body.appendChild(snow);
  }
})();
