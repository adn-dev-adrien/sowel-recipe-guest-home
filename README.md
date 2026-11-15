# Sowel Recipe — Domotique des voyageurs

Alimente la page « Domotique » de l'appli séjour de [guestFlow](https://github.com/adn-dev-adrien/guestFlow) :
températures des pièces, météo, pluie, électricité du logement, et les lumières que vous confiez
aux voyageurs. Les échanges passent par le plugin
[guestFlow](https://github.com/adn-dev-adrien/sowel-plugin-guestflow) (v0.5.0 et plus), et son
device « home-bridge » ; cette recette est ce qui lit la maison, décide et actionne.

**Une seule instance pour toute la maison**, comme `guest-gate`.

## Pourquoi une recette, et pas le plugin lui-même

Parce que **rien de ce qui décide ne doit aussi actionner**. Un jeton d'API Sowel ne se restreint
pas : guestFlow n'en détient donc aucun, c'est la maison qui l'appelle. Le plugin parle à Internet
et ne fait que porter les messages ; il n'envoie d'ordre à aucun équipement. La recette, elle, ne
peut actionner **qu'une lumière que vous avez cochée** dans son unique réglage — quoi que guestFlow
demande, rien d'autre dans la maison n'est joignable par ce chemin.

Le pire cas, accepté par Adrien le 2026-11-15 : quelqu'un qui contrôlerait entièrement guestFlow
pourrait allumer ou éteindre **les lumières confiées**, au plus 20 fois par heure et par logement,
et rien d'autre.

## Le seul réglage : « Lumières confiées aux voyageurs »

Une liste de lumières à cocher, remplie une fois. C'est la frontière de sécurité : aucune commande
n'atteint une lumière hors de cette liste. Tout le reste — quel logement montre quoi, les libellés,
quelle lumière confiée est « Pilotable » dans quel logement — se règle dans le Studio de guestFlow.

Une lumière, c'est un équipement `light_onoff`, `light_dimmable`, `light_color`, ou un `switch`
qui porte un état de lumière (`light_state`). Le formulaire propose aussi les autres `switch` ; la
validation les refuse.

## Ce qu'elle fait

- **Le catalogue** — au démarrage, à chaque équipement créé, renommé, déplacé ou supprimé (et à
  chaque zone renommée), puis toutes les heures : les capteurs, thermostats, stations météo,
  compteurs d'énergie et lumières de la maison, avec leur nom, leur zone (« Gîte › Salon »), leur
  type et ce qu'ils mesurent (alias, catégorie, unité). **Aucune valeur.** Une lumière porte
  `guestSwitchable: true` si et seulement si elle est cochée. Jamais deux fois le même, hors le renvoi horaire.
- **Les relevés** — toutes les 60 s, la valeur, l'unité et l'heure de mesure, **seulement pour les
  couples que guestFlow a demandés** (`home_selection`). Le reste de la maison ne sort pas.
- **Les séries** — à chaque heure pleine, la pluie (`rain_1h`) et l'énergie (`energy_hour`) de
  l'heure écoulée sont gardées dans la mémoire de la recette (24 tranches), et envoyées toutes les
  15 min. Après une installation neuve, la courbe se remplit en 24 h.
- **Les commandes** — une commande n'est exécutée que si **tout** tient :
  1. l'équipement existe et est une lumière ;
  2. il est coché dans « Lumières confiées aux voyageurs » ;
  3. la commande a moins de 60 s ;
  4. moins de 20 commandes pour ce logement dans l'heure (compte gardé à travers un redémarrage).

  Elle part alors sur l'ordre `state` de la lumière (`ON`/`OFF` pour une énumération,
  `true`/`false` pour un booléen). Pas de minuterie : la lumière reste comme le voyageur l'a
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
4. Une seule instance : la zone de la tuile, l'équipement du pont, et les lumières confiées.

La validation refuse un pont sans ses quatre ordres et ses trois données, et une « lumière » qui
n'en est pas une.

## Licence

AGPL-3.0
