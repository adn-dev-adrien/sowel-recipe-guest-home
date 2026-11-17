# Sowel Recipe — Domotique des voyageurs

Alimente la page « Domotique » de l'appli séjour de [guestFlow](https://github.com/adn-dev-adrien/guestFlow) :
températures des pièces, météo, pluie, électricité du logement, et les lumières que vous confiez
aux voyageurs. Les échanges passent par le plugin
[guestFlow](https://github.com/adn-dev-adrien/sowel-plugin-guestflow) (v0.5.0 et plus), et son
device « home-bridge » ; cette recette est ce qui lit la maison, décide et actionne.

**Une seule instance pour toute la maison**, comme `guest-gate`.

## Pourquoi une recette, et pas le plugin lui-même

Parce que **rien de ce qui décide ne doit aussi actionner, ni rien dire de plus que ce qu'on lui confie**. Un jeton d'API Sowel ne se restreint
pas : guestFlow n'en détient donc aucun, c'est la maison qui l'appelle. Le plugin parle à Internet
et ne fait que porter les messages ; il n'envoie d'ordre à aucun équipement. La recette, elle, ne
peut actionner **qu'une lumière que vous avez cochée** dans son unique réglage — quoi que guestFlow
demande, rien d'autre dans la maison n'est joignable par ce chemin. Et elle ne **décrit** à guestFlow
que les équipements de son second réglage : le reste de la maison n'existe pas pour lui.

Le pire cas, accepté par Adrien le 2026-11-15 : quelqu'un qui contrôlerait entièrement guestFlow
pourrait allumer ou éteindre **chaque lumière confiée**, au plus 20 fois par heure, et rien d'autre.
Le compte se fait par lumière et non par logement, car c'est guestFlow qui nomme le logement.

## Deux réglages, deux frontières

**« Capteurs partagés »** (depuis la 0.2.0) — les seuls capteurs, thermostats, stations météo et
compteurs d'énergie dont guestFlow peut connaître le nom, la zone et les mesures. C'est la frontière
de lecture : un équipement non coché n'est jamais décrit, donc jamais demandé, jamais envoyé, quoi
que guestFlow demande. Laissé vide, aucun capteur n'est décrit.

**« Lumières confiées aux voyageurs »** — une liste de lumières à cocher, remplie une fois. C'est la
frontière d'action : aucune commande n'atteint une lumière hors de cette liste. Tout le reste — quel logement montre quoi, les libellés,
quelle lumière confiée est « Pilotable » dans quel logement — se règle dans le Studio de guestFlow.

Une lumière, c'est un équipement `light_onoff`, `light_dimmable`, `light_color`, ou un `switch`
qui porte un état de lumière (`light_state`). Le formulaire propose aussi les autres `switch` ; la
validation les refuse.

## Ce qu'elle fait

Tout ce qu'elle envoie est une valeur que Sowel détient déjà : **elle ne calcule rien**. Et chaque
envoi étant un ordre du pont, inscrit dans le journal d'activité de Sowel, **elle n'envoie que ce qui
a changé**.

- **Le catalogue** — au démarrage, puis à chaque équipement créé, renommé, déplacé ou supprimé (et à
  chaque zone renommée), **seulement s'il a changé** : les capteurs partagés et les lumières confiées,
  avec leur nom, leur zone (« Gîte › Salon »), leur type et ce qu'ils mesurent (alias, catégorie,
  unité). **Aucune valeur.** Une lumière porte `guestSwitchable: true` si et seulement si elle est
  cochée. Le plugin garde le dernier et le renvoie lui-même à guestFlow chaque heure, sans ordre.
- **Les relevés** — chaque minute, la recette compare ; elle n'envoie que **les couples dont la
  valeur a changé** (ou, pour une valeur stable, une fois par heure, pour que guestFlow sache que Sowel
  la mesure toujours), seulement s'ils sont demandés par guestFlow (`home_selection`) **et décrits
  par le catalogue**. Rien n'a changé : aucun ordre. Un envoi raté est refait à la minute suivante.
  Le **min/max du jour** est celui que Sowel suit depuis minuit (`temperature_min_today` /
  `temperature_max_today`) : relayé comme une mesure ordinaire quand l'équipement l'a — aujourd'hui
  les stations météo ; les simples sondes avec la spec 211 de sowel-core.
- **Les séries** — une fois par heure close, les 24 dernières tranches horaires de la pluie et de
  l'énergie, **lues dans l'historique de Sowel** (`ctx.helpers.history`, spec 211 de sowel-core) et
  transmises telles quelles : des heures complètes seulement, chacune datée de son début, jamais
  l'heure en cours. Sans cet accès (un Sowel plus ancien), aucune série n'est envoyée — jamais
  d'estimation ; tout le reste fonctionne. Un historique indisponible (`ok: false`) n'est pas une
  absence de pluie : rien n'est envoyé et la lecture est refaite à la minute suivante ; un refus de
  débit garde ce qui a déjà été lu et reprend là où il s'était arrêté.
- **Les commandes** — une commande n'est exécutée que si **tout** tient :
  1. il est coché dans « Lumières confiées aux voyageurs » (vérifié en premier : un refus ne dit
     rien d'un équipement inconnu) ;
  2. l'équipement existe et est une lumière ;
  3. la commande a moins de 60 s ;
  4. moins de 20 commandes pour cette lumière dans l'heure (compte gardé à travers un redémarrage) ;
  5. ce numéro de commande n'a pas déjà été traité dans l'heure.

  Elle part alors sur l'ordre `state` de la lumière (`ON`/`OFF` pour une énumération qui les
  nomme, `true`/`false` pour un booléen ; tout autre ordre donne `order_failed`). Pas de minuterie : la lumière reste comme le voyageur l'a
  laissée. Le verdict repart vers guestFlow — `not_a_light`, `not_entrusted`, `too_old`,
  `rate_limited`, `order_failed`, ou `invalid_command` pour une commande illisible. Jamais
  réessayée. Chaque refus est écrit dans le journal de la recette avec le numéro de la commande ;
  chaque exécution apparaît dans l'Activité.

## Deux garde-fous sur le compteur

- **Jamais sur sa première lecture.** Au démarrage, `home_command_seq` a déjà une valeur ; un
  redémarrage de recette ne doit pas allumer une lumière.
- **Seule une valeur strictement supérieure** est une nouvelle commande.

## Installation

1. Plugin guestFlow en v0.5.0 au moins, configuré : il publie le device **home-bridge**
   (« Domotique GuestFlow »).
2. Créer un équipement depuis ce device, toutes ses données et tous ses ordres liés, alias laissés
   tels quels (`home_catalog`, `home_readings`, `home_series`, `home_result`, `home_selection`,
   `home_command`, `home_command_seq`).
3. Source personnelle (spec 136) : **Plugins → Store → Sources personnelles** →
   `adn-dev-adrien/sowel-recipe-guest-home` → Installer → confirmer l'empreinte.
4. Une seule instance : la zone de la tuile, l'équipement du pont, les **capteurs partagés** et les
   lumières confiées. En passant de la 0.1.0 à la 0.2.0, modifier l'instance pour remplir « Capteurs
   partagés » : tant qu'il est vide, guestFlow ne voit que les lumières.

La validation refuse un pont sans ses quatre ordres et ses trois données, une « lumière » qui
n'en est pas une, et un capteur partagé qui n'est ni capteur, ni thermostat, ni station, ni compteur.

## Licence

AGPL-3.0
