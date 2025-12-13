(function () {
  const images = [
    "/images/background-image/img1.jpg",
    "/images/background-image/img2.jpg",
    "/images/background-image/img3.jpg"
  ];
  const bg = images[Math.floor(Math.random() * images.length)];
  document.body.style.backgroundImage = `url('${bg}')`;
})();
