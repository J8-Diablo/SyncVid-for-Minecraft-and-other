// /public/js/main-i18n.js

// on utilise le back-end pour charger /locales/{{lng}}/translation.json
i18next
  .use(i18nextHttpBackend)
  .init({
    fallbackLng: 'fr',
    debug: true,
    backend: {
      loadPath: '/locales/{{lng}}/translation.json'
    }
  }, function(err, t) {
    // une fois initialisé, on localise tout le DOM
    jqueryI18next.init(i18next, $, { useOptionsAttr: true });
    $('body').localize();
  });

// gestion du changement de langue
$('#languageSwitcher').on('change', function() {
  const newLang = $(this).val();
  i18next.changeLanguage(newLang, () => {
    $('body').localize();
  });
});