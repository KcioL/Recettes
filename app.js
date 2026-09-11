/* =========================================================
   CONFIGURATION : à remplir
   Console Firebase > Paramètres du projet > Général > Vos applications > Config
   (ces valeurs peuvent être publiques : ce sont les règles Firestore qui protègent les données)
   ========================================================= */
const firebaseConfig = {
  apiKey: "TA_CLE_API",
  authDomain: "ton-projet.firebaseapp.com",
  projectId: "ton-projet",
  appId: "TON_APP_ID",
};

const TITRE = "Mon carnet de recettes"; // mets son prénom !

/* ========================================================= */

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, getDoc, getDocs, setDoc, updateDoc, writeBatch,
  query, orderBy, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

const app = document.getElementById("app");
const PASTELS = ["lavande", "menthe", "peche", "beurre", "rose", "ciel"];

let auth, db;
let utilisateur = null;
let recettesCache = null;        // liste des recettes gardée en mémoire
const photosCache = new Map();   // id de photo -> image (data URL)
let recherche = "";
let scrollAccueil = 0;
let wakeLock = null;

/* =========================================================
   Utilitaires
   ========================================================= */

const esc = (s = "") =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const sansAccents = (s = "") => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

// Chaque recette garde toujours la même couleur pastel
function pastelDe(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `c-${PASTELS[h % PASTELS.length]}`;
}

const icones = {
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  retour: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',
  loupe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/></svg>',
  croix: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  photo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  lien: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
};

function toast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 2600);
}

function aller(hash, { remplacer = false } = {}) {
  if (remplacer) {
    history.replaceState(null, "", hash);
    route();
  } else {
    location.hash = hash;
  }
}

function urlValide(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

function libelleSource(url) {
  const u = urlValide(url);
  if (!u) return null;
  const hote = u.hostname.replace(/^www\./, "");
  if (hote.endsWith("instagram.com")) return "Voir la publication Instagram";
  if (hote.endsWith("tiktok.com")) return "Voir la vidéo TikTok";
  if (hote.endsWith("youtube.com") || hote === "youtu.be") return "Voir la vidéo YouTube";
  if (hote.includes("pinterest.")) return "Voir sur Pinterest";
  return `Voir la recette sur ${hote}`;
}

// Nettoie les lignes collées depuis Insta ou un site ("- ", "• ", "1. ", "Étape 2 :")
function lignes(texte, { numeros = false } = {}) {
  return texte
    .split("\n")
    .map((l) => {
      let s = l.trim().replace(/^[-•*–·]\s+/, "");
      if (numeros) s = s.replace(/^(?:étape|etape)\s*\d+\s*[:.\-–]?\s*/i, "").replace(/^\d+\s*[.)]\s+/, "");
      return s.trim();
    })
    .filter(Boolean);
}

/* ---------- Photos ----------
   Les photos sont stockées directement dans Firestore (en texte "data URL"),
   ce qui évite Cloud Storage, devenu payant (plan Blaze obligatoire).
   Un document Firestore est limité à 1 Mo, donc on réduit chaque photo. */

function chargerImage(source) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = source instanceof Blob ? URL.createObjectURL(source) : source;
    img.onload = () => {
      if (source instanceof Blob) URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      if (source instanceof Blob) URL.revokeObjectURL(url);
      const nom = source.name ? `« ${source.name} » ` : "";
      reject(new Error(`La photo ${nom}n'a pas pu être lue. Essaie avec un fichier JPEG ou PNG`));
    };
    img.src = url;
  });
}

function redimensionner(img, tailleMax, qualite) {
  const ratio = Math.min(1, tailleMax / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * ratio);
  canvas.height = Math.round(img.naturalHeight * ratio);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", qualite);
}

async function preparerPhoto(source) {
  const img = await chargerImage(source);
  // on essaie la meilleure qualité qui tient sous ~750 Ko
  for (const [taille, qualite] of [[1400, 0.8], [1200, 0.72], [1000, 0.65], [800, 0.6]]) {
    const data = redimensionner(img, taille, qualite);
    if (data.length < 750_000) return data;
  }
  return redimensionner(img, 640, 0.55);
}

async function preparerMiniature(source) {
  return redimensionner(await chargerImage(source), 480, 0.72);
}

/* =========================================================
   Données Firestore
   recettes/{id}                  titre, ingredients[], etapes[], source, notes,
                                  photos[] (ids dans l'ordre), miniature, creeLe, modifieLe
   recettes/{id}/photos/{photoId} data
   ========================================================= */

async function chargerRecettes({ forcer = false } = {}) {
  if (recettesCache && !forcer) return recettesCache;
  const snap = await getDocs(query(collection(db, "recettes"), orderBy("creeLe", "desc")));
  recettesCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return recettesCache;
}

async function chargerRecette(id) {
  const trouvee = recettesCache?.find((r) => r.id === id);
  if (trouvee) return trouvee;
  const snap = await getDoc(doc(db, "recettes", id));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

async function chargerPhotos(recette) {
  const manquantes = recette.photos.filter((id) => !photosCache.has(id));
  if (manquantes.length) {
    const snap = await getDocs(collection(db, "recettes", recette.id, "photos"));
    snap.forEach((d) => photosCache.set(d.id, d.data().data));
  }
  return recette.photos.map((id) => ({ id, data: photosCache.get(id) })).filter((p) => p.data);
}

/* =========================================================
   Routeur (#/  #/recette/:id  #/ajouter  #/modifier/:id)
   ========================================================= */

async function route() {
  libererEcran();
  if (!utilisateur) return pageConnexion();

  const parties = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  try {
    if (parties.length === 0) return await pageAccueil();
    if (parties[0] === "recette" && parties[1]) return await pageRecette(parties[1]);
    if (parties[0] === "ajouter") return await pageFormulaire();
    if (parties[0] === "modifier" && parties[1]) return await pageFormulaire(parties[1]);
    aller("#/", { remplacer: true });
  } catch (err) {
    console.error(err);
    pageErreur(err);
  }
}

/* =========================================================
   Pages
   ========================================================= */

function pageConfiguration() {
  app.innerHTML = `
    <main class="ecran seyes">
      <div class="carte avec-marge">
        <h1>Presque prêt</h1>
        <p>Il manque la configuration Firebase en haut du fichier <strong>app.js</strong>.</p>
        <p class="muet">Console Firebase, Paramètres du projet, puis « Vos applications ».</p>
      </div>
    </main>`;
}

function pageConnexion() {
  document.title = TITRE;
  app.innerHTML = `
    <main class="ecran seyes">
      <form class="carte avec-marge" id="form-connexion" novalidate>
        <h1>${esc(TITRE)}</h1>
        <div id="erreur-connexion"></div>
        <div class="champ">
          <label for="email">Adresse e-mail</label>
          <input id="email" type="email" autocomplete="email" required>
        </div>
        <div class="champ">
          <label for="mdp">Mot de passe</label>
          <input id="mdp" type="password" autocomplete="current-password" required>
        </div>
        <button class="btn" type="submit">Se connecter</button>
      </form>
    </main>`;

  document.getElementById("form-connexion").addEventListener("submit", async (e) => {
    e.preventDefault();
    const bouton = e.target.querySelector("button");
    const zone = document.getElementById("erreur-connexion");
    bouton.disabled = true;
    bouton.textContent = "Connexion…";
    try {
      await signInWithEmailAndPassword(auth, document.getElementById("email").value.trim(), document.getElementById("mdp").value);
      // onAuthStateChanged s'occupe d'afficher le carnet
    } catch (err) {
      const messages = {
        "auth/too-many-requests": "Trop d'essais. Réessaie dans quelques minutes.",
        "auth/network-request-failed": "Pas de connexion internet.",
      };
      zone.innerHTML = `<p class="erreur">${messages[err.code] || "E-mail ou mot de passe incorrect."}</p>`;
      bouton.disabled = false;
      bouton.textContent = "Se connecter";
    }
  });
}

async function pageAccueil() {
  document.title = TITRE;
  if (!recettesCache) app.innerHTML = `<p class="chargement">Ouverture du carnet…</p>`;
  const recettes = await chargerRecettes();

  app.innerHTML = `
    <header class="entete seyes avec-marge">
      <div class="entete-inner">
        <h1 class="titre-carnet">${esc(TITRE)}</h1>
        <a class="btn" href="#/ajouter">${icones.plus}<span>Ajouter</span></a>
      </div>
    </header>
    <main class="page">
      ${
        recettes.length === 0
          ? `<div class="vide seyes avec-marge">
               <p>Le carnet est encore vide.<br>Ajoute ta première recette.</p>
               <a class="btn" href="#/ajouter">${icones.plus}<span>Ajouter une recette</span></a>
             </div>`
          : `<label class="recherche">
               ${icones.loupe}
               <span class="sr-only">Rechercher</span>
               <input id="recherche" type="search" placeholder="Une recette, un ingrédient…" value="${esc(recherche)}" autocomplete="off">
             </label>
             <p class="compteur" id="compteur"></p>
             <ul class="grille" id="grille"></ul>`
      }
      <div class="pied"><button class="lien" id="deconnexion">Se déconnecter</button></div>
    </main>`;

  document.getElementById("deconnexion").addEventListener("click", () => signOut(auth));
  if (recettes.length === 0) return;

  const grille = document.getElementById("grille");
  const compteur = document.getElementById("compteur");
  const champ = document.getElementById("recherche");

  const afficher = () => {
    const q = sansAccents(recherche.trim());
    const liste = q ? recettes.filter((r) => sansAccents([r.titre, ...r.ingredients].join(" ")).includes(q)) : recettes;
    const s = liste.length > 1 ? "s" : "";
    compteur.textContent = q ? `${liste.length} recette${s} trouvée${s}` : `${recettes.length} recette${recettes.length > 1 ? "s" : ""}`;

    grille.innerHTML = liste
      .map(
        (r) => `
        <li>
          <a class="fiche ${pastelDe(r.id)}" href="#/recette/${r.id}">
            ${
              r.miniature
                ? `<img class="fiche-photo" src="${esc(r.miniature)}" alt="" loading="lazy">`
                : `<div class="fiche-vide seyes" aria-hidden="true">${esc(r.titre.trim().charAt(0).toUpperCase())}</div>`
            }
            <h2 class="fiche-titre">${esc(r.titre)}</h2>
          </a>
        </li>`
      )
      .join("");
  };

  champ.addEventListener("input", () => {
    recherche = champ.value;
    afficher();
  });
  grille.addEventListener("click", () => (scrollAccueil = window.scrollY));

  afficher();
  requestAnimationFrame(() => window.scrollTo(0, scrollAccueil));
}

async function pageRecette(id) {
  window.scrollTo(0, 0);
  if (!recettesCache) app.innerHTML = `<p class="chargement">Ouverture de la recette…</p>`;
  const r = await chargerRecette(id);
  if (!r) {
    toast("Cette recette n'existe plus.");
    return aller("#/", { remplacer: true });
  }
  document.title = `${r.titre} | ${TITRE}`;

  const couleur = pastelDe(r.id);
  const source = libelleSource(r.source);
  const ecranDispo = "wakeLock" in navigator;

  app.innerHTML = `
    <nav class="barre">
      <a class="retour" href="#/">${icones.retour}<span>Recettes</span></a>
      <a class="btn btn-clair" href="#/modifier/${r.id}">Modifier</a>
    </nav>

    ${
      r.photos.length
        ? `<div class="photos-wrap ${couleur}">
             <div class="photos" id="photos">
               ${r.photos
                 .map((pid, i) => {
                   // la miniature s'affiche tout de suite, la vraie photo arrive juste après
                   const src = photosCache.get(pid) || (i === 0 ? r.miniature : "");
                   return `<img data-photo="${esc(pid)}" ${src ? `src="${esc(src)}"` : ""} alt="${esc(r.titre)}, photo ${i + 1}">`;
                 })
                 .join("")}
             </div>
             ${r.photos.length > 1 ? `<span class="photos-compteur" id="photos-compteur">1 / ${r.photos.length}</span>` : ""}
           </div>`
        : ""
    }

    <header class="titre-bloc seyes avec-marge ${couleur}">
      <div class="titre-bloc-inner">
        <h1 class="titre-recette">${esc(r.titre)}</h1>
        ${
          source || ecranDispo
            ? `<div class="actions">
                 ${source ? `<a class="btn" href="${esc(r.source)}" target="_blank" rel="noopener noreferrer">${icones.lien}<span>${esc(source)}</span></a>` : ""}
                 ${
                   ecranDispo
                     ? `<label class="interrupteur">
                          <input type="checkbox" id="ecran">
                          <span class="piste" aria-hidden="true"></span>
                          <span>Garder l'écran allumé</span>
                        </label>`
                     : ""
                 }
               </div>`
            : ""
        }
      </div>
    </header>

    <main class="contenu">
      <section class="ingredients" aria-labelledby="t-ingredients">
        <h2 class="section-titre" id="t-ingredients">Ingrédients</h2>
        ${
          r.ingredients.length
            ? `<ul class="liste-ingredients">
                 ${r.ingredients.map((ing) => `<li><label><input type="checkbox"><span>${esc(ing)}</span></label></li>`).join("")}
               </ul>`
            : `<p class="muet">Aucun ingrédient noté.</p>`
        }
      </section>

      <section class="preparation" aria-labelledby="t-etapes">
        <h2 class="section-titre" id="t-etapes">Préparation</h2>
        ${
          r.etapes.length
            ? `<ol class="liste-etapes">${r.etapes.map((e) => `<li>${esc(e)}</li>`).join("")}</ol>`
            : `<p class="muet">Aucune étape notée.</p>`
        }
        ${r.notes ? `<aside class="notes"><h3>Notes</h3>${esc(r.notes)}</aside>` : ""}
      </section>
    </main>`;

  // photos en pleine qualité
  if (r.photos.length) {
    chargerPhotos(r)
      .then((photos) => {
        for (const p of photos) {
          const img = app.querySelector(`img[data-photo="${CSS.escape(p.id)}"]`);
          if (img) img.src = p.data;
        }
      })
      .catch((err) => console.warn("Photos non chargées", err));
  }

  const photosEl = document.getElementById("photos");
  const compteurPhotos = document.getElementById("photos-compteur");
  if (photosEl && compteurPhotos) {
    photosEl.addEventListener(
      "scroll",
      () => {
        const i = Math.round(photosEl.scrollLeft / photosEl.clientWidth);
        compteurPhotos.textContent = `${i + 1} / ${r.photos.length}`;
      },
      { passive: true }
    );
  }

  const interrupteur = document.getElementById("ecran");
  if (interrupteur) {
    interrupteur.addEventListener("change", async () => {
      if (interrupteur.checked) {
        try {
          wakeLock = await navigator.wakeLock.request("screen");
        } catch {
          interrupteur.checked = false;
          toast("Ton navigateur n'a pas autorisé l'écran allumé.");
        }
      } else {
        libererEcran();
      }
    });
  }
}

async function pageFormulaire(id = null) {
  window.scrollTo(0, 0);
  let r = null;
  let photos = []; // { id, data } pour les photos enregistrées, { fichier, apercu } pour les nouvelles

  if (id) {
    app.innerHTML = `<p class="chargement">Ouverture de la recette…</p>`;
    r = await chargerRecette(id);
    if (!r) return aller("#/", { remplacer: true });
    photos = await chargerPhotos(r);
  }
  document.title = `${r ? "Modifier" : "Nouvelle recette"} | ${TITRE}`;
  const aSupprimer = [];

  app.innerHTML = `
    <nav class="barre">
      <a class="retour" href="${r ? `#/recette/${r.id}` : "#/"}">${icones.retour}<span>Annuler</span></a>
    </nav>

    <form class="form" id="form-recette" novalidate>
      <h1>${r ? "Modifier la recette" : "Nouvelle recette"}</h1>
      <div id="erreur-form"></div>

      <div class="champ">
        <label for="titre">Nom de la recette</label>
        <input id="titre" type="text" required maxlength="200" value="${esc(r?.titre || "")}" placeholder="Tarte aux poireaux">
      </div>

      <div class="champ">
        <span class="label">Photos</span>
        <p class="aide">Touche une photo pour la mettre en couverture.</p>
        <div class="vignettes" id="vignettes"></div>
      </div>

      <div class="champ">
        <label for="ingredients">Ingrédients</label>
        <p class="aide">Un ingrédient par ligne.</p>
        <textarea id="ingredients" placeholder="3 poireaux&#10;200 g de crème fraîche&#10;1 pâte brisée">${esc((r?.ingredients || []).join("\n"))}</textarea>
      </div>

      <div class="champ">
        <label for="etapes">Préparation</label>
        <p class="aide">Une étape par ligne. Les numéros sont ajoutés automatiquement.</p>
        <textarea id="etapes" style="min-height:12rem" placeholder="Émincer les poireaux et les faire fondre 15 min.&#10;Mélanger avec la crème et les œufs.">${esc((r?.etapes || []).join("\n"))}</textarea>
      </div>

      <div class="champ">
        <label for="source">Lien d'inspiration</label>
        <p class="aide">Publication Instagram, vidéo, site de recettes…</p>
        <input id="source" type="url" inputmode="url" value="${esc(r?.source || "")}" placeholder="https://www.instagram.com/p/…">
      </div>

      <div class="champ">
        <label for="notes">Notes <span class="muet">(facultatif)</span></label>
        <textarea id="notes" style="min-height:6rem" placeholder="Moins de sucre la prochaine fois">${esc(r?.notes || "")}</textarea>
      </div>

      <div class="barre-enregistrer">
        <div class="barre-enregistrer-inner">
          ${r ? `<button type="button" class="btn btn-danger" id="supprimer">Supprimer</button>` : ""}
          <button type="submit" class="btn" id="enregistrer">Enregistrer la recette</button>
        </div>
      </div>
    </form>`;

  const vignettes = document.getElementById("vignettes");
  const zoneErreur = document.getElementById("erreur-form");
  const montrerErreur = (message) => {
    zoneErreur.innerHTML = `<p class="erreur">${esc(message)}</p>`;
    window.scrollTo({ top: 0 });
  };

  const dessinerVignettes = () => {
    vignettes.innerHTML =
      photos
        .map(
          (p, i) => `
        <div class="vignette">
          <button type="button" class="couv" data-couv="${i}" aria-label="Mettre la photo ${i + 1} en couverture">
            <img src="${esc(p.apercu || p.data)}" alt="">
          </button>
          ${i === 0 ? `<span class="badge">Couverture</span>` : ""}
          <button type="button" class="retirer" data-retirer="${i}" aria-label="Retirer la photo ${i + 1}">${icones.croix}</button>
        </div>`
        )
        .join("") +
      (photos.length < 12
        ? `<label class="ajout-photo">
             ${icones.photo}
             <span>Ajouter des photos</span>
             <input type="file" id="fichiers" accept="image/*" multiple>
           </label>`
        : "");
  };
  dessinerVignettes();

  vignettes.addEventListener("click", (e) => {
    const retirer = e.target.closest("[data-retirer]");
    const couv = e.target.closest("[data-couv]");
    if (retirer) {
      const [p] = photos.splice(Number(retirer.dataset.retirer), 1);
      if (p.id) aSupprimer.push(p.id);
      if (p.apercu) URL.revokeObjectURL(p.apercu);
      dessinerVignettes();
    } else if (couv && couv.dataset.couv !== "0") {
      const [p] = photos.splice(Number(couv.dataset.couv), 1);
      photos.unshift(p);
      dessinerVignettes();
    }
  });

  vignettes.addEventListener("change", (e) => {
    if (e.target.id !== "fichiers") return;
    for (const fichier of [...e.target.files].slice(0, 12 - photos.length)) {
      photos.push({ fichier, apercu: URL.createObjectURL(fichier) });
    }
    dessinerVignettes();
  });

  if (r) {
    document.getElementById("supprimer").addEventListener("click", async () => {
      if (!confirm(`Supprimer « ${r.titre} » ? Cette action est définitive.`)) return;
      if (!navigator.onLine) return montrerErreur("Pas de connexion internet : impossible de supprimer pour l'instant.");
      try {
        const ref = doc(db, "recettes", r.id);
        const photosSnap = await getDocs(collection(ref, "photos"));
        const batch = writeBatch(db);
        photosSnap.forEach((d) => batch.delete(d.ref));
        batch.delete(ref);
        await batch.commit();
        r.photos.forEach((pid) => photosCache.delete(pid));
        recettesCache = null;
        toast("Recette supprimée");
        aller("#/", { remplacer: true });
      } catch (err) {
        console.error(err);
        montrerErreur(`La suppression a échoué (${err.code || err.message}).`);
      }
    });
  }

  document.getElementById("form-recette").addEventListener("submit", async (e) => {
    e.preventDefault();
    zoneErreur.innerHTML = "";
    const bouton = document.getElementById("enregistrer");
    const titre = document.getElementById("titre").value.trim();
    const sourceBrute = document.getElementById("source").value.trim();

    if (!titre) {
      montrerErreur("Donne un nom à la recette pour l'enregistrer.");
      return document.getElementById("titre").focus();
    }
    if (sourceBrute && !urlValide(sourceBrute)) {
      montrerErreur("Le lien d'inspiration doit commencer par https://");
      return document.getElementById("source").focus();
    }
    if (!navigator.onLine) {
      return montrerErreur("Pas de connexion internet : la recette ne peut pas être enregistrée pour l'instant.");
    }

    bouton.disabled = true;
    const ref = r ? doc(db, "recettes", r.id) : doc(collection(db, "recettes"));
    const envoyees = [];

    try {
      // 1. envoyer les nouvelles photos (un document par photo)
      const nouvelles = photos.filter((p) => p.fichier);
      let n = 0;
      for (const p of nouvelles) {
        bouton.textContent = `Envoi des photos (${++n}/${nouvelles.length})…`;
        const data = await preparerPhoto(p.fichier);
        const photoRef = doc(collection(ref, "photos"));
        await setDoc(photoRef, { data });
        envoyees.push(photoRef);
        photosCache.set(photoRef.id, data);
        p.id = photoRef.id;
        p.data = data;
      }

      // 2. la miniature de couverture (réutilisée si la couverture n'a pas changé)
      bouton.textContent = "Enregistrement…";
      let miniature = null;
      if (photos.length) {
        miniature = r?.miniature && r.photos[0] === photos[0].id ? r.miniature : await preparerMiniature(photos[0].data);
      }

      // 3. la recette
      const donnees = {
        titre,
        ingredients: lignes(document.getElementById("ingredients").value),
        etapes: lignes(document.getElementById("etapes").value, { numeros: true }),
        source: sourceBrute || null,
        notes: document.getElementById("notes").value.trim() || null,
        photos: photos.map((p) => p.id),
        miniature,
        modifieLe: serverTimestamp(),
      };
      if (r) await updateDoc(ref, donnees);
      else await setDoc(ref, { ...donnees, creeLe: serverTimestamp() });

      // 4. supprimer les photos retirées
      if (aSupprimer.length) {
        const batch = writeBatch(db);
        aSupprimer.forEach((pid) => {
          batch.delete(doc(ref, "photos", pid));
          photosCache.delete(pid);
        });
        await batch.commit().catch((err) => console.warn("Nettoyage des photos", err));
      }

      photos.forEach((p) => p.apercu && URL.revokeObjectURL(p.apercu));
      await chargerRecettes({ forcer: true });
      toast(r ? "Modifications enregistrées" : "Recette enregistrée");
      aller(`#/recette/${ref.id}`, { remplacer: true });
    } catch (err) {
      console.error(err);
      // on retire les photos envoyées pour rien
      if (envoyees.length) {
        const batch = writeBatch(db);
        envoyees.forEach((pr) => batch.delete(pr));
        batch.commit().catch(() => {});
      }
      photos.forEach((p) => {
        if (p.fichier) { delete p.id; delete p.data; }
      });
      const detail = err.code === "permission-denied" ? "accès refusé par les règles Firestore" : err.message;
      montrerErreur(`L'enregistrement a échoué : ${detail}.`);
      bouton.disabled = false;
      bouton.textContent = "Enregistrer la recette";
    }
  });
}

function pageErreur(err) {
  if (err.code === "permission-denied") {
    app.innerHTML = `
      <main class="ecran seyes">
        <div class="carte avec-marge">
          <h1>Accès refusé</h1>
          <p>Ce compte n'est pas autorisé dans les règles Firestore. Ajoute cet identifiant (UID) dans la liste :</p>
          <p><code>${esc(utilisateur?.uid || "")}</code></p>
          <button class="btn" id="deconnexion">Se déconnecter</button>
        </div>
      </main>`;
    document.getElementById("deconnexion").addEventListener("click", () => signOut(auth));
    return;
  }
  app.innerHTML = `
    <main class="ecran seyes">
      <div class="carte avec-marge">
        <h1>Oups</h1>
        <p>${navigator.onLine ? `Le carnet n'a pas pu se charger (${esc(err.code || err.message || "erreur inconnue")}).` : "Pas de connexion internet. Reconnecte-toi puis réessaie."}</p>
        <button class="btn" id="reessayer">Réessayer</button>
      </div>
    </main>`;
  document.getElementById("reessayer").addEventListener("click", () => {
    recettesCache = null;
    route();
  });
}

function libererEcran() {
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

// l'écran allumé est coupé quand on change d'appli : on le redemande au retour
document.addEventListener("visibilitychange", async () => {
  const interrupteur = document.getElementById("ecran");
  if (document.visibilityState === "visible" && interrupteur?.checked) {
    try { wakeLock = await navigator.wakeLock.request("screen"); } catch {}
  }
});

/* =========================================================
   Démarrage
   ========================================================= */

function demarrer() {
  document.title = TITRE;
  if (firebaseConfig.apiKey.startsWith("TA_") || firebaseConfig.projectId.startsWith("ton-projet")) {
    return pageConfiguration();
  }

  const firebase = initializeApp(firebaseConfig);
  auth = getAuth(firebase);
  // cache local : les recettes déjà ouvertes restent consultables avec une connexion faible
  db = initializeFirestore(firebase, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });

  let premierAppel = true;
  onAuthStateChanged(auth, (user) => {
    const change = (user?.uid || null) !== (utilisateur?.uid || null);
    utilisateur = user;
    if (change) {
      recettesCache = null;
      photosCache.clear();
      recherche = "";
      scrollAccueil = 0;
      if (!user) history.replaceState(null, "", "#/");
    }
    if (change || premierAppel) route();
    premierAppel = false;
  });

  window.addEventListener("hashchange", route);
}

demarrer();
