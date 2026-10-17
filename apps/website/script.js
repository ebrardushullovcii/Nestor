(() => {
  /* Tour dialog: opens the 38 second tour in place. Without JS the link opens the video file. */
  const dialog = document.getElementById("tour-dialog");
  if (dialog && typeof dialog.showModal === "function") {
    const tourVideo = dialog.querySelector("video");
    document.querySelectorAll("[data-tour]").forEach((link) => {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        dialog.showModal();
        if (tourVideo) tourVideo.play().catch(() => {});
      });
    });
    dialog
      .querySelector("[data-tour-close]")
      ?.addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
    dialog.addEventListener("close", () => tourVideo?.pause());
  }

  /* Early access forms: posted to Netlify Forms. Without JS the form posts normally. */
  document.querySelectorAll("[data-signup]").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const status = form.querySelector(".form-status");
      const button = form.querySelector('button[type="submit"]');
      if (button) button.disabled = true;
      try {
        const response = await fetch("/", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(new FormData(form)).toString(),
        });
        if (!response.ok) throw new Error(String(response.status));
        form.reset();
        if (status)
          status.textContent =
            "Thank you. We will email you when you can try Nestor.";
      } catch {
        if (status)
          status.textContent =
            "That did not go through. Please try again in a moment.";
      } finally {
        if (button) button.disabled = false;
      }
    });
  });
})();
