# Le (vrai) coût d'un outil de récupération structurelle de code

> Version française de [`STUDY_STRUCTURAL_LIMITS.md`](STUDY_STRUCTURAL_LIMITS.md), qui fait référence et
> dont chaque chiffre est recalculé par `bench/replay-ceiling/verify_independent.py`.

## Résumé

Compresser la sortie des outils agentiques n'est pas la solution à la réduction de coûts.
Cette étude pose la question inverse : est-ce qu'injecter un payload structurel de bonne qualité permettrait de faciliter le traitement par le LLM, à la fois en termes de rapidité mais également de coût ? Cette étude montre que non.

À l'aide d'un oracle de replay (outil "parfait" permettant de rejouer la sortie d'un outil structurel sans latence ni mauvais chemin),
j'ai pu volontairement nourrir les agents du chemin "idéal" à prendre pour retrouver les liens entre les parties de code, le tout en 6 "tours" d'appel à l'outil (le dernier affichant `DONE`).

Exemple :
```shell
$ call-flow --step 1
=== step 1 of 5 ===
# Locate route: /admin/realms
147 route(s) matched; 1 with BOTH sides resolved - the crossing itself, [...]

- /admin/realms
    serves   integration/admin-client/src/main/java/org/keycloak/admin/client/resource/RealmsResource.java:35
    serves   services/src/main/java/org/keycloak/services/resources/admin/AdminRoot.java:232
    fetches  js/libs/keycloak-admin-client/src/resources/realms.ts:409
[...]
--- next: call-flow --step 2 ---

$ call-flow --step 2
=== step 2 of 5 ===
# Agent map - the region to read instead of a grep loop
[...]
  Realms (js/libs/keycloak-admin-client/src/resources/realms.ts:22) - PINNED CENTER
      22> export class Realms extends Resource {
[... 27 Ko ...]
--- next: call-flow --step 3 ---

$ call-flow --step 3
=== step 3 of 5 ===
# Coupling of RealmAdminResource (cross-stack data boundary)
anchor: RealmAdminResource | shape: coupling | shared keys: 40 | counterpart sites: 57
[...]

$ call-flow --step 4
=== step 4 of 5 ===
# Locate: 6 name(s)
## getRealm - 25 definition(s) of 207 - narrow with `--in <path-prefix>`
[...]

$ call-flow --step 5
=== step 5 of 5 ===
# Locate: 2 name(s)
## updateRealm - 1 definition(s)
- server-spi-private/src/main/java/org/keycloak/models/utils/RepresentationToModel.java:285#updateRealm
[...]

$ call-flow --step 6
DONE - no further steps. You have everything the trace can give you.
```

Avec une réponse prouvée complète, l'agent fait 14,8 appels supplémentaires (dont 4,6 refusés) après le marqueur `DONE`, ce qui représente 52 % du coût du run, et il termine à 21,8 tours du modèle contre 23,4 pour le contrôle.
La conclusion est que, sans les appels refusés, son contexte total vaut 1,003x celui du contrôle malgré l'accès à la réponse complète à environ un tiers du contexte.

La réponse des 6 appels de l'oracle a été poussée à la vérification par l'agent, et cette dernière a lu à elle seule près des deux tiers du contexte du contrôle.

=> En termes de coûts, l'outil (Seam) livré tel quel coûte 1,36x (ajusté) alors qu'il réduit les appels d'outils de 36 %.


On en déduit avant tout que la vérification après la réponse ne dépend pas de la qualité de la réponse, donc la réduction de tours sur laquelle repose tout l'échange n'arrive pas, même avec un outil idéal. Et cela est également valide sur un second modèle, Sonnet (sur 3 rounds, avec un plancher plus petit).
C'est donc qu'il y a une notion de "plancher de vérification" : le plancher est ce besoin de vérifier par le modèle.
On déduit également que la prime d'écriture est la totalité du surcoût restant : le volume d'informations à ingurgiter provenant de l'oracle pèse dans les calculs de coût, car le payload est écrit dans le cache d'un bloc, tôt, à 20 fois le prix d'une lecture ; et comme l'outil réduit justement le nombre de tours, il en reste peu pour amortir cette écriture, là où grep écrit de petits morceaux au fil du run.

À l'inverse, et en tant qu'ouverture : un oracle réduit à sa réponse seule exacte (et non un simple "rejeu" des possibilités d'un outil comme Seam) coûte 0,45x grep et est moins cher dans les 5 rounds, mais l'agent vérifie encore une dizaine de fois après une réponse complète obtenue en un seul appel.
De là à savoir si cet outil idéal, nécessitant un jugement sémantique, est réalisable, c'est là où je m'arrêterai...

---

## Introduction

Une étude récente (arXiv 2607.12161) a montré qu'une réduction du nombre de tokens n'implique pas
forcément une réduction des coûts.

Ici, nous avons testé une approche différente, avec à l'appui un outil nommé "Seam", issu d'un projet
qui avait pour objectif d'optimiser les coûts et les performances d'un agent lors du traçage d'un "flow"
de code.

Une fois Seam fabriqué, je me suis rendu compte que, malgré un nombre d'appels d'outils divisé par 2,7 en
moyenne sur une première mesure (6 rounds sur Keycloak), et malgré moins de tokens consommés au total, la facture avait
augmenté de 18 % et le temps de 9 %, alors que je m'attendais à l'inverse. Une seule catégorie de tokens
avait augmenté : l'écriture dans le cache.

Ce résultat m'a amené à créer un "replay" représentant l'outil structurel déterministe parfait, sans
aucune latence, et à réaliser un benchmark basé dessus. L'outil de replay contient la réponse "parfaite"
typique sur un flow d'exécution, sans latence ni surcharge, et le bras correspondant l'obtient en cinq
appels d'outil successifs. Au sixième appel, l'oracle affiche `DONE` : la réponse est complète.

Encore plus étonnant : avec ce scénario d'outil parfait, l'agent obtient la réponse en peu d'appels, mais
une fois la réponse récupérée, il a tendance à la revérifier et à s'étendre, en continuant à consommer des
tokens.

En chiffres, sur 5 rounds appariés :

- l'outil parfait, avec le payload de Seam, coûte **1,13x** le contrôle grep (1,26x en brut, appels refusés
  compris) ;
- la totalité du surcoût restant, **+13 %**, vient de l'écriture dans le cache ;
- après une réponse complète, l'agent fait encore **14,8 appels** (10,2 exécutés, 4,6 refusés), qui
  représentent **52 %** du coût du run ;
- lui donner en plus un moyen de recherche rend chaque vérification moins chère, mais ne change presque
  pas le nombre de vérifications ;
- ce plancher se retrouve sur un second modèle (Sonnet, 3 rounds), dans chaque round, mais plus petit ;
- en revanche, réduit à la réponse seule, le même oracle coûte **0,45x** grep (§8) : c'est la taille du
  payload de Seam qui fait perdre l'outil idéal. Le plancher, lui, est toujours là.

---

## 1. Motivation

Seam trace un flow de code à travers un dépôt : quels fichiers y participent, où il traverse plusieurs langages, couches et services puis où il se termine. L'hypothèse / motivation de départ était évidente : un outil qui répond en moins d'étapes qu'un agent qui avance à coups de grep devrait coûter moins cher que cet agent.

La première mesure, six rounds de grep contre Seam (`bench/grep-vs-seam/results/kcC-*`), a confirmé la première moitié et réfuté la seconde : **2,7x moins d'appels
d'outils, et une facture 18 % plus élevée.** Chaque catégorie de tokens que l'outil devait faire baisser a
baissé - tokens de sortie -19 %, lectures du cache -19 %, temps d'API -19 % - et la facture a monté quand
même, parce que la seule catégorie qui a augmenté est **l'écriture dans le cache** (x1,79). De plus, le temps total
a augmenté de 9 %.

**Le contexte / périmètre.** 
Le dépôt utilisé comme étude est Keycloak, un monolithe contenant à la fois un client Typescript et un serveur Java, l'idéal donc dans le sens où on matérialise directement les plusieurs couches.

Les chiffres viennent de cinq séries de runs, toutes sur ce dépôt et cette tâche :

| série | rounds | bras | utilisée en | dossier |
|---|---|---|---|---|
| première mesure | 6 | grep, Seam | Introduction, §1, §4.2 | `bench/grep-vs-seam/results/` (`kcC-*`) |
| benchmark principal | 5 | grep, Seam, oracle | partout ailleurs, dont le tableau ci-dessous | `bench/replay-ceiling/results/` |
| oracle + recherche | 5 | grep, oracle, oracle + grep | §5.2 | `bench/replay-ceiling/results-oracle-grep/` |
| second modèle (Sonnet) | 3 | grep, oracle | §6.2, §8.2 | `bench/replay-ceiling/results-sonnet-clean/` |
| oracle réduit à la réponse | 5 | grep, oracle, oracle réduit | §8.1 | `bench/replay-ceiling/results-min-payload/` |

Sauf mention contraire, un chiffre est une moyenne du benchmark principal.

| par run, moyenne | GREP | SEAM | REPLAY (idéal) |
|---|---|---|---|
| appels d'outils | 22,4 | **14,4** | 20,8 |
| tours du modèle | 23,4 | **15,4** | 21,8 |
| tokens de contexte / tour | 41 882 | **83 955** | 57 152 |
| tokens de thinking | 1 108 | **2 177** (1,97x) | **2 145** (1,94x) |
| écriture cache | 36 779 | 62 923 | 49 991 |
| lecture cache | 943 264 | 1 229 982 | 1 195 918 |
| temps total (mesuré par le shell) | 85 s | 119 s | 89 s |
| appels refusés (dispositif) | 0,0 | 1,6 | 4,6 |
| **coût facturé, brut** | **1,00 $** | **1,42 $ (1,42x)** | **1,26 $ (1,26x)** |
| **coût facturé, ajusté** | **1,00 $** | **1,36 $ (1,36x)** | **1,13 $ (1,13x)** |

Round par round (coût brut), pour montrer que ce n'est pas un effet de moyenne :

| | r1 | r2 | r3 | r4 | r5 | plus cher |
|---|---|---|---|---|---|---|
| SEAM vs GREP | 1,01x | 1,37x | 1,51x | 1,68x | 1,53x | **4 sur 5**, 1 à égalité |
| REPLAY vs GREP | 1,26x | 1,18x | 1,00x | 1,41x | 1,48x | **4 sur 5**, 1 à égalité |

"À égalité" signifie à moins de 1 % du contrôle.
Aucun round n'est moins cher que grep.

---

## 2. Travaux associés

**L'étude de la réduction des coûts par la réduction de tokens a déjà été menée.** *Token Reduction Is Not Cost Reduction* (arXiv 2607.12161).
Elle mesure 2 908 lancements de Claude Code, sur 103 tâches, 7 dépôts et 3 modèles. Elle traite un sujet
corollaire, sans couvrir celui-ci. Elle montre en particulier :

- qu'une réduction de tokens au niveau d'un composant ne prédit pas le coût de bout en bout
- que la facture est **dominée par le cache** : écriture 44,3 % + lecture 35,4 % ≈ 80 % du total
- que sa compression la plus agressive a réduit les tokens de sortie d'outil de **38,4 %** et augmenté le
  coût facturé de **6,8 %**.

Dans cette étude, je me concentre sur trois points qu'elle laisse ouverts :

1. **L'intervention opposée.** Elle compresse : elle retire de la sortie d'outil pour économiser des tokens.
   Ici on injecte : un payload plus large en contrepartie de beaucoup moins d'appels. La direction est
   opposée et la conclusion reste la même : les coûts augmentent. C'est donc une étude complémentaire.
2. **L'isolation de la vérification.** Avec une compression, l'agent peut légitimement relire ce qui a été
   coupé : relecture et manque d'information sont confondus. Ici rien n'est retiré et rien n'est faux : la
   réponse est complète. Toute vérification après `DONE` ne s'explique donc par aucun manque d'information.
3. **Le coût d'un outil parfait.** Aucun travail de ce domaine ne mesure ce que coûterait un outil optimal,
   qui ne pourrait jamais exister en pratique, mais qui représente la meilleure version possible de tout outil
   de ce type : le replay.

**Travaux voisins.** *Redundant or Necessary?* (arXiv 2605.29893) construit un benchmark pour **détecter** les
étapes redondantes d'un agent. Il les classe sans les chiffrer, et n'a pas de bras type oracle.

*When the Tool Decides: LLM Agents Defer Blindly to Graph Neural Network Tools* (arXiv 2606.14476) semble
dire l'inverse de la section 5 : ses agents recopient la réponse de leur outil, un réseau de neurones sur
graphe (un modèle qui prédit l'étiquette d'un nœud à partir de ses voisins). Mais il ne la contredit pas: son agent ne peut pas vérifier : l'outil lui donne directement l'étiquette qu'il doit rendre, et il n'a rien d'extérieur pour la contrôler. 
Seam et l'oracle nôtre ont le dépôt ouvert à côté et peuvent vérifier chaque affirmation. 
Cet article mesure aussi autre chose que nous (ce que l'agent fait de la réponse, pas combien d'appels il choisit de faire), et son effet extrême est en partie propre au modèle Qwen (selon ses propres auteurs)...

---

## 3. Méthode

### 3.1 Les bras et les contrôles

J'ai choisi une tâche précise, sur un commit fixe du dépôt Keycloak, sur laquelle trois bras ont été exécutés à la suite, puis les résultats compilés et comparés.

Le modèle est fixé: (`claude-opus-5[1m]`).
Le CLI facture aussi un petit modèle dans chaque run, environ 0,5 % du
coût, inclus dans tous les totaux.

**L'ordre des bras est tiré au hasard à chaque round.** La contamination entre bras est vérifiée dans les transcripts, pas supposée à partir des options : **les cinq rounds sont propres**.

- **A - GREP** : ripgrep et lecture de fichiers. Le "contrôle".
- **B - SEAM** : le vrai CLI avec son vrai `SKILL.md`. Le produit tel qu'il est livré.
- **C - REPLAY** : l'oracle idéalisé (§3.2).

La **seule** capacité qui diffère est la recherche de contenu : tous les bras ont les mêmes commandes de
lecture et de listing, et l'outil `Read`. Seul le bras A a `rg`, `grep`, `Grep` et `Glob`.

### 3.2 L'instrument : l'oracle de replay est une borne supérieure

`call-flow --step N` constitue l'oracle en retournant successivement cinq fichiers enregistrés, dans un ordre particulier imposé, puis affiche `DONE`.
Chaque étape est **la sortie exacte qu'un vrai run de Seam a produite** sur cette question et ce commit, que j'ai "sauvegardée" à un instant T (stockée ici : `bench/replay-ceiling/steps/`), et aucune information n'a été ajoutée. 
Une seule retouche : le nom de
l'outil a été effacé de l'étape 2 (quelques mots comme `seam` ou `SEAM_` remplacés par des termes neutres, et
une ligne retirée, qui suggérait une commande `seam` que le bras C n'a pas), pour que l'agent ne sache pas quel
outil il remplace. L'original est conservé à côté (`steps/step2.txt.orig`).

Cette mise en place d'oracle supprime toutes les façons dont un outil de récupération pourrait perdre :

| supprimé | bras C (REPLAY) | bras B (SEAM) |
|---|---|---|
| latence du moteur | ~1 ms (un `cat`) - indiscernable du contrôle | **+20,6 s** hors API par run |
| mauvais chemins, mauvais point de départ | aucun : ordre fixé à l'avance | l'agent choisit |
| coût de la documentation | ~300 octets | 42 Ko, présents à chaque tour |
| rappel | 100 % de la vérité terrain par construction | mesuré |

**Qu'est ce que contient notre payload ?**

Le payload est le texte que l'outil injecte dans le contexte de l'agent. Ici,
les cinq étapes livrent **43 Ko de texte, environ 13k tokens** :

1. **la table des routes** : 147 routes trouvées, dont une seule résolue des deux côtés, celle que
   la tâche demande
2. **la carte pour l'agent** (27 Ko, l'essentiel du payload) : la région du code à lire au lieu d'enchaîner
   des grep, avec les lignes de code source
3. **le couplage entre les deux langages** de la ressource Java, indexé par route plutôt que par
   symbole
4. et 5. **huit symboles nommés**, chacun résolu en un fichier et une ligne

(Un détail explique la taille du payload : `getRealm` a 207 définitions dans le dépôt, et l'outil en renvoie
25 en laissant l'agent choisir) 

**Un outil structurel est gros en partie car il ne porte pas de décision / jugement sémantique et ne peut donc trancher** : il explique honnêtement qu'il ne peut pas réduire, et cette honnêteté coûte des tokens.

**Coût pour le reproduire sur n'importe quel outil :** figer les sorties de l'outil sur une tâche, les
servir avec `cat`, écrire un manuel de 300 octets.

Le temps hors API (temps total moins temps d'API) n'est qu'une approximation grossière du temps du moteur :
il est même légèrement négatif pour le contrôle. Avec Seam, le temps du "moteur" ajoutait +20,6s, ce qui n'est pas ignorable.
Celui de l'oracle est donné comme indiscernable du contrôle plutôt que comme un chiffre.

### 3.3 Modèle de coût (rappel sur le fonctionnement existant de la facturation actuelle des LLMs)

Quatre catégories de tokens facturés dans chaque run enregistré :

```
entrée          5,00 $ /Mtok
lecture cache   0,50 $ /Mtok    payée À CHAQUE tour, sur tout le prompt
écriture cache 10,00 $ /Mtok    payée UNE FOIS par octet, au tour où il entre dans le contexte
                                (TTL 1 h ; TTL 5 min = 6,25 $)
sortie         25,00 $ /Mtok
```

---

## 4. Le mécanisme de coût

Cette section reprend un mécanisme déjà établi par l'étude 2607.12161, ce n'est pas un résultat de cette étude.

=> L'idée : le surcoût d'un outil de récupération de code vient de la façon dont le cache est écrit et lu.
À chaque tour, toute la conversation est renvoyée au modèle : le prompt initial, les payloads des outils et toutes
les réponses précédentes. Elle grossit donc à chaque tour. Un payload agit alors de deux façons :

1. **il alourdit chaque tour suivant**, puisqu'il est relu à chaque tour (§4.1)
2. **il est écrit une fois dans le cache, à 20x le prix d'une lecture**, et moins il reste de tours après
   lui, moins cette écriture s'amortit (§4.2).

Un même payload joue sur les deux à la fois, en sens opposé : s'il est gros, il permet de s'arrêter plus
tôt, mais il pèse sur chaque tour restant, et plus on s'arrête tôt, moins son écriture est amortie. S'il est
petit, il ne permet pas de gagner vraiment sur grep.

![Un payload, deux factures](figures/01-two-bills.svg)

***Figure 1.** Les deux termes et leurs prix : 0,50 $/Mtok payés à chaque tour restant, contre 10,00 $/Mtok
payés une fois.*

### 4.1 Le contexte total

Le contexte total utilisé est défini par :

```
    context_per_turn     =  (cache_read + cache_write) / turns
    total input context  =  turns  ×  context_per_turn
```

Ce qui signifie que les coûts sont liés à la somme des contextes sur tous les tours, pas à la taille finale
du contexte. Effectuer deux fois moins de tours avec un contexte deux fois plus gros n'apporte donc rien. Un
payload ne fait baisser la lecture que s'il supprime plus de tours qu'il n'alourdit chacun d'eux, donc si le
contexte total du bras finit sous celui du contrôle :

| par run, moyenne | tours | dont refusés | contexte / tour | contexte total | vs GREP |
|---|---|---|---|---|---|
| GREP | 23,4 | 0,0 | 41,9k | 980k | 1,00 |
| SEAM | 15,4 | 1,6 | 84,0k | 1 293k brut · **1 159k ajusté** | 1,32 brut · **1,18 ajusté** |
| REPLAY (idéal) | 21,8 | 4,6 | 57,2k | 1 246k brut · **983k ajusté** | 1,27 brut · **1,003 ajusté** |

La ligne ajustée compte tous les appels sauf les refusés ; elle compare un outil utilisé à côté de grep. La
ligne brute sert à une comparaison directe avec grep lorsque l'outil le remplace.

La ligne ajustée de REPLAY n'est pas l'idéal : elle contient deux limites. La première est `DONE`, qui
matérialise la dernière réponse utile de l'outil et marque la fin des données. La seconde est atteinte
lorsque l'agent juge qu'il possède suffisamment d'informations et s'arrête. L'idéal s'arrêterait à `DONE`.
L'écart entre les deux est lourd de conséquences, et aboutit à la conclusion finale de ce papier.

Concrètement, le bras idéal avait la réponse complète à **346k**, environ un tiers de ce que lit grep. Côté
lecture, il gagne donc largement ; ce qui le ramène sur la ligne de grep, ce sont les **637k** que l'agent
passe ensuite à vérifier une réponse déjà complète. Seam, lui, perd l'échange dans les deux cas (1,18).

![Contexte total par run, appels refusés séparés](figures/02-area-not-endpoint.svg)

***Figure 2.** Chaque barre est le contexte total d'un bras (tours × contexte par tour), sur une même
échelle. L'extrémité hachurée correspond aux appels refusés, seule partie que l'ajustement retire. La ligne
verticale marque le contrôle. La barre du bras idéal est coupée là où sa réponse est devenue complète
(`DONE`, au 6e appel dans chaque round) : 346k pour y arriver, puis 637k de vérification. Seul ce bras peut
être coupé ainsi, parce que lui seul a un marqueur de fin. Sans les refus, il s'arrête sur la ligne, et près
des deux tiers de ce qui l'y amène est de la vérification.*

### 4.2 L'inversion de l'amortissement

Le surcoût vient de l'écriture. Une écriture coûte 2,0x le prix d'une entrée, une lecture 0,1x : la lecture
coûte donc 20x moins. Un payload n'est rentable que si **chaque token qu'il ajoute au contexte économise au
moins vingt tokens de relecture** (un rapport inférieur à 0,050). Avec un cache de 5 minutes, l'écriture
coûte 1,25x et le seuil est de 0,080.

Avec la ligne ajustée de §4.1, la lecture est neutre. Tout ce que l'outil idéal coûte de plus que le
contrôle vient donc de l'écriture :

```
écart de coût ajusté du bras C par rapport à GREP :
    écriture cache   +0,1321 $      <- la totalité
    lecture cache    -0,0051 $      <- indiscernable de zéro
    sortie           +0,0047 $
    TOTAL            +0,1317 $      = +13 %
```

![Où va l'argent de l'outil idéal](figures/05-where-the-money-goes.svg)

***Figure 5.** L'outil idéal lit autant que grep: tout son surcoût vient de l'écriture dans le cache*

L'essentiel du surcoût de l'oracle et d'un outil idéal est dans la mise en place de ce dernier.
Par mise en place, on entend l'écriture dans le cache elle-même, qui est payée une fois par octet lors du tour où l'octet entre dans le contexte de l'agent.
Ceci implique une notion d'amortissement au fil des appels: plus il reste d'appels après la mise en place, plus le coût de cette dernière peut "s'étaler" dans les tours.

En tant qu'exemple, un octet écrit une fois puis lu *T* fois coûte `(10 + 0,5T)/T` dollars par
million de tokens et par tour d'utilisation :

| tours après le payload | 20 | 10 | 4 | 2 | 1 |
|---|---|---|---|---|---|
| prix effectif ($/Mtok-tour) | 1,00 $ | 1,50 $ | 3,00 $ | 5,50 $ | 10,50 $ |

Chaque tour possède une partie d'écriture, et ce qui est nouveau depuis le tour précédent passe par le même calcul de coûts.
Le prompt coûte au tour 1 (14,1k, à peu près identique dans tous les bras), puis chaque résultat d'outil au tour qui suit son retour.

Les cinq étapes de l'oracle arrivent aux tours 2 à 6, et l'une domine :
dans l'étape 2, la carte qui pèse en tout 11,7k, écrite au tour 3.

Les résultats de grep sont écrits de la même façon, par morceaux d'environ 1k à 3k répartis sur tout le run.

Le problème : un outil de récupération suffisamment optimisé a justement pour objectif de diminuer les tours,
ce qui raccourcit la période sur laquelle sa propre écriture s'amortit.

=> En admettant qu'on atteigne un seul appel, chaque octet du payload coûtera environ 20x le prix d'une lecture, là où grep a le profil inverse : ses octets arrivent tard, sont relus peu de fois, mais au prix normal.

![L'inversion de l'amortissement](figures/03-amortisation-inversion.svg)

***Figure 3.** Un octet écrit une fois et lu T fois coûte (10 + 0,5T)/T par Mtok-tour. Réduire les tours fait
glisser l'outil vers la gauche de la courbe, vers la prime complète de 20x sur ses propres octets.*

**Ce qui s'est passé quand les tours ont vraiment baissé.** Dans la première mesure (§1, 6 rounds), Seam a divisé les tours par 2,6 (de 24,7 à 9,7). Pour cela, il a ajouté 24,1k tokens d'écriture et
économisé 136,8k tokens de lecture : un rapport de **0,176, soit 3,5x au-dessus du seuil**. 

=> Pour être rentable, son payload aurait dû tenir en 6 838 tokens (la carte seule en fait environ 7k), ou il aurait
fallu répondre en **3,9 tours, moins que ses 8,7 appels d'outils**.

**Attention** Ce calcul ne rend pas impossible un vrai outil à un seul appel. Avec un payload
hypothétique de 36k tokens et un seul tour, l'écriture coûte 0,36 $, contre environ 0,49 $ de lecture
accumulée pour grep : il gagnerait. 
La section 8 le mesure : réduit à la réponse seule, l'oracle gagne, dans la limite du plancher de la section 5.

### 4.3 Le "thinking" double, et ne pèse presque pas sur la facture

Mesuré directement depuis les outils d'Anthropic, le contrôle "pense" **1 108** tokens par run, Seam **2 177**
(**1,97x**) et le bras idéal **2 145** (**1,94x**). 

La partie thinking double en comparaison avec grep:
- le thinking est compté comme de la sortie, et la sortie est une petite partie de la facture :
environ 6,5k tokens par run, contre environ 1M de tokens de contexte. Dans le bras idéal, la sortie représente
13 % du coût.
- le surplus de thinking est presque entièrement compensé. Les bras qui pensent plus écrivent
moins de texte et d'appels, parce qu'ils font moins d'appels : le bras idéal pense environ 1 040 tokens de plus
que le contrôle, mais écrit environ 850 tokens de moins. Sa sortie totale n'augmente que d'environ 190
tokens, soit les +0,0047 $ de §4.2, moins de 4 % de son surcoût ajusté. Compter le thinking seul le
surestimerait d'environ cinq fois.

Où ce thinking a lieu est un résultat de la section 5 : 99 % se trouve après `DONE`.

---

## 5. Résultat : le plancher de vérification

En résumé : le plancher de vérification, ce sont des tours entièrement consacrés à vérifier la réponse alors qu'elle est déjà construite et connue. 
Je parle de "plancher", car améliorer la réponse de l'outil ne parvient pas à le faire baisser : même avec une réponse parfaite et complète, l'agent continue de vérifier.

![Le plancher de vérification](figures/04-verification-floor.svg)

***Figure 4.** Le bras idéal, seul : les autres bras n'ont pas de marqueur `DONE`, donc la quantité n'est pas
mesurable pour eux. 6 appels mènent à la réponse prouvée complète, 14,8 suivent, et les 23 refus des cinq
rounds tombent tous dans cette seconde partie.*

| REPLAY (idéal), par run | appels d'outils | dont exécutés | dont refusés | part du coût du run |
|---|---|---|---|---|
| avant `DONE` : obtenir la réponse | 6,0 | 6,0 | 0,0 | 48 % |
| **après `DONE` : la vérifier** | **14,8** | **10,2** | **4,6** | **52 %** |

Sur le bras idéal, `DONE` est atteint au bout de 6 appels. Les 20,8 appels du run (en moyenne sur 5 rounds)
se répartissent donc en 6 appels pour obtenir la réponse et 14,8 appels de vérification, dont 4,6 sont des
appels refusés.
L'agent termine en 21,8 tours contre 23,4 pour grep : 7 % de moins, avec un outil qui lui
avait déjà donné toute la réponse.

Si on reprend la figure 2, on note que 346k de contexte sont nécessaires pour atteindre la réponse, et 637k
sont consacrés à la vérification (plus 263k d'appels refusés).
=> La vérification seule lit 65 % de ce que grep lit pour toute la tâche. 
**99 % du thinking** du bras idéal se trouve dans cette phase : 19 tokens par run pendant les six appels qui apportent la réponse, 2 126 pendant la vérification.
**Le modèle ne réfléchit presque pas pendant que la réponse arrive : il réfléchit pendant qu'il vérifie une réponse déjà complète.**

Les 14,8 appels représentent 71 % des appels du bras, mais seulement 52 % de son coût. C'est le mécanisme
d'amortissement (section §4.2) à l'intérieur d'un seul run : les sept premiers appels portent 67 % de l'écriture dans le cache, parce que le payload y arrive, et la longue suite après `DONE` relit à un vingtième de ce prix.

**Il faut quand même noter que le plancher a une limite** et un agent qui reçoit une réponse d'outil qu'il ne peut pas vérifier la recopie au lieu de la vérifier (§2). Dans notre cas, le dépôt est ouvert à côté de l'agent, donc chaque affirmation de l'oracle peut être vérifiée.

### 5.1 La vérification survit à un outil "parfait"

Dans le bras idéal, tout ce qui sert à *obtenir* la réponse est au mieux (voir section §3.2) : aucune latence, une
réponse complète, un manuel de 300 octets. 

**L'agent vérifie quand même** : 10,2 appels exécutés après `DONE`.
Une seule chose lui manque : un moyen simple de vérifier. Après `DONE`, l'oracle n'a plus rien à donner et
la recherche est refusée, donc chaque vérification passe par la lecture de fichiers entiers. La section 5.2
lui donne la recherche et mesure la différence.

### 5.2 L'agent vérifie-t-il autant parce qu'il n'a pas de bon moyen de vérifier ? Une piste à vérifier : le bras D

**Le bras D est le bras idéal munit de la recherche ordinaire**.
Si la vérification après `DONE` n'était que le prix de l'absence de recherche, le bras D vérifierait
beaucoup moins. Les bras A, C et D ont tourné ensemble, cinq rounds appariés dans un ordre tiré au hasard, sur
une même machine (`bench/replay-ceiling/results-oracle-grep/`).

| par run, après `DONE` | REPLAY (sans recherche) | REPLAY + grep (bras D) |
|---|---|---|
| tentatives de recherche refusées | 7,8 | 0 |
| recherches exécutées | 0 | 6,2 |
| lectures de fichiers exécutées | 17,0 | 9,6 |
| autres (`ls`, `find`) | 1,4 | 0 |
| **vérifications réellement exécutées** | **18,4** | **15,8** |

Une commande qui lit et cherche à la fois (`sed ... && grep ...`) compte comme une recherche, puisqu'elle en
exécute une.

| par run, sur tout le run - cette machine | GREP | REPLAY | REPLAY + grep |
|---|---|---|---|
| appels d'outils | 35,2 | 32,2 | 21,8 |
| coût facturé vs GREP | 1,00 | 1,23 brut · 1,06 ajusté | **0,91** |

Trois résultats :

1. **La quantité de vérifications ne baisse presque pas** Le nombre d'appels du bras D
   après `DONE` baisse de 10,4, mais 7,8 d'entre eux sont les tentatives refusées, qui cessent simplement
   dès que la recherche est permise. Ce qui change, c'est la nature de ces appels : environ la moitié des lectures de fichiers entiers deviennent des recherches ciblées.
2. **Le plancher résiste au moyen de vérifier.** Il a suivi l'oracle jusqu'à `DONE` dans chaque round, sans rien chercher avant.
3. **En coût, l'outil idéal utilisé à côté de grep est au niveau de grep seul.** Ses vérifications coûtent moins cher, très probablement parce qu'une recherche renvoie moins de texte qu'un fichier entier : le bras D est moins cher que le bras idéal sans recherche dans les 5 rounds en brut, et dans 4 sur 5 en ajusté. Le bras idéal sans recherche perd toujours, dans le même sens que les rounds publiés. 
   => La conclusion dépend donc de l'usage que distingue §6.1 (point 4) : utilisé **à la place** de grep, l'outil idéal perd ; utilisé **à côté** de grep, il arrive à l'égalité, sans jamais réussir à gagner.

---

## 6. Menaces à la validité

### 6.1 Les asymétries entre les bras

1. **Seam "paie" sa propre documentation.** Son `SKILL.md` est inclus dans le prompt : au premier tour, Seam écrit
   30,9k tokens dans le cache contre 14,0k pour grep (+16,8k, identique dans les 5 rounds), et ce texte reste
   présent pendant tout le run. C'est le produit tel qu'il est livré, donc l'enlever serait injuste dans
   l'autre sens.
2. **Seam a un cache à mettre en place**. `grep` et l'oracle n'en ont pas. Cela **favorise Seam**.
3. **L'oracle est construit à partir des sorties de Seam**, en choisissant les cinq résultats qui couvrent
   ensemble toute la vérité terrain.
4. **Seam et l'oracle n'ont pas accès à la recherche : il faut dire sur quel coût repose chaque affirmation.**
   - Si l'outil est présenté comme un **remplaçant** de grep, les refus sont une vraie gêne qu'un
     utilisateur rencontrerait, et c'est la ligne brute qui compte.
   - S'il est présenté comme un **complément** de grep, ce qui est le cas de Seam, les refus viennent du
     dispositif, et c'est la ligne ajustée qui compte. Le bras D mesure directement ce cas au
     lieu de l'ajuster : l'outil idéal avec grep coûte **0,91x** grep seul, ce qui n'est pas distinguable de
     l'égalité (§5.2).
   - Le plancher de vérification (§5) tient dans les deux cas. La parité de §4.1 repose sur la lecture
     ajustée. **Il faut annoncer l'usage avant de citer un chiffre.**

### 6.2 Généralité

- **Une tâche sur un dépôt particulier et 5 rounds par bras.** Le mécanisme de coût de la section 4 est de l'arithmétique : il se généralise, et 2607.12161 l'observe sur 2 908 runs. Le plancher de la section 5, lui, est un
  comportement **mesuré** : son existence et sa taille doivent être mesurées sur chaque modèle.
- **Sur un second modèle, le plancher est présent dans chaque round, mais plus petit.** Trois rounds de
  grep et de l'oracle sur Sonnet : `DONE` au 6e appel à chaque fois, tous les refus après lui et aucun avant,
  puis **9, 4 et 8 vérifications exécutées** après la réponse complète, contre 6 à 14 sur Opus (moyenne 7,0
  contre 10,2). Un round passe sous la fourchette d'Opus : la taille du plancher dépend donc du modèle, son
  existence non. Les limites : 3 rounds, pas de bras Seam, une autre machine, un CLI plus récent (2.1.303),
  et Keycloak dans le même état de juillet 2026 que les rounds publiés. Aucune commande autorisée n'a été
  refusée (`bench/replay-ceiling/results-sonnet-clean/WHY.md`). L'étude passe ainsi d'un modèle à deux pour
  l'*existence* du plancher, pas pour sa *taille*.
- **En coût, l'oracle sur Sonnet est au niveau de son contrôle** : 0,97x en moyenne, mais 1,06x, 0,58x et
  1,42x selon les rounds, un écart trop grand pour en dire plus avec 3 rounds. Un plancher plus petit est
  exactement ce qui devrait rapprocher l'oracle de l'égalité, mais 3 rounds ne permettent pas de le
  distinguer du bruit.
- **Le seuil de 20:1 dépend de la durée de vie du cache, pas du modèle.** Les prix facturés, retrouvés à
  partir des transcripts, sont de 5 / 0,5 / 10 / 25 $ par million de tokens pour Opus et de 3 / 0,3 /
  3,75 (cache 5 min) ou 6,00 (cache 1 h) / 15 $ pour Sonnet. Dans les deux cas, une lecture coûte 0,1x
  l'entrée et une écriture avec un cache d'une heure 2,0x : le seuil est de 0,050 pour les deux modèles, et
  le niveau de prix s'annule. Sonnet est simplement 3 fois moins cher partout, et l'échange est identique.
  Avec un cache de 5 minutes, le seuil passe à 0,080 (12,5:1) : l'échange y est plus facile à gagner.
- **Ce qui pourrait encore contredire l'étude :**
  - une tarification sans un coût d'écriture du cache si élevé
  - une conversation assez longue pour que l'amortissement l'emporte
  - une tâche où le contexte du contrôle grossit plus vite que le payload.

  Un modèle qui ne revérifierait pas a été cherché deux fois, sans succès : sur un second modèle (le plancher
  y est plus petit, mais présent dans chaque round), et dans la littérature, où l'article le plus proche
  (2606.14476) mesure un autre régime, sans aucun moyen de vérifier (§2).

---

## 7. Ce que cette étude ne dit pas

- **Ce n'est pas un verdict sur un outil en particulier.** L'outil livré est le bras B, et il n'est là que
  parce que l'oracle devait être construit à partir des sorties enregistrées d'un vrai outil. Savoir si cet
  outil vaut la peine d'être utilisé est une autre question (portée, honnêteté, cohérence sur des questions
  qu'un serveur de langage ne sait pas traiter), qui demande d'autres preuves et n'est pas tranchée ici.
  L'affirmation porte sur une **catégorie** : ce que coûte un outil qui répond en injectant un payload de
  cette taille, borné par ce que coûte le meilleur outil concevable qui renvoie ce payload.
- **Elle ne dit pas que tout outil de récupération perd.** Un outil réduit à la réponse seule gagne
  nettement (§8).
- **Elle ne dit pas que le nombre d'appels est une mauvaise mesure.** La réduction de 36 % est réelle. Ce
  n'est simplement **pas une mesure du coût**, et ici les deux axes vont en sens opposé.
- **Ce n'est pas un nouveau mécanisme de coût.** La section 4 reprend un mécanisme connu (§2).

---

## 8. Ouverture

### 8.1 Un outil réduit à la réponse : le bras E

L'oracle de cette étude est optimal en latence, en ordre et en rappel, mais pas en taille : il sert les
~13k tokens réels de Seam. **Le bras E est le même oracle réduit à la réponse seule** : un seul appel, qui
renvoie les 12 emplacements de la vérité terrain (`fichier:ligne#symbole`) et le passage REST, soit 1,7 Ko
(environ 500 tokens), puis `DONE`. Même prompt, mêmes commandes autorisées, pas de recherche. Les bras A, C
et E ont tourné ensemble, cinq rounds appariés dans un ordre tiré au hasard, sur Opus et sur une même
machine (`bench/replay-ceiling/results-min-payload/`).

| par run | GREP | REPLAY (C) | REPLAY réduit (E) |
|---|---|---|---|
| coût vs GREP | 1,00 | 1,25 | **0,45** |
| rounds moins chers que grep | - | 1 sur 5 | **5 sur 5** |
| écriture dans le cache | 45k | 48k | 22k |
| vérifications exécutées après `DONE` | - | 20,4 | 10,2 |

- **Réduit à la réponse, l'outil idéal bat grep d'un facteur deux**, dans les 5 rounds. Son écriture dans le
  cache est même plus faible que celle de grep. C'est ce que prévoyait le calcul de §4.2 : un payload n'est
  rentable que sous ~6,8k tokens, celui de C en fait ~13k, celui de E ~0,5k.
- **Le plancher est toujours là.** Avec la réponse complète dès le premier appel, l'agent vérifie encore 10
  fois en moyenne, et 25 fois dans un round, où son coût remonte au niveau de grep (0,99x). Le plancher
  n'annule pas le gain, mais il le plafonne et le rend imprévisible.
  => Il apparaît ainsi dans trois situations : l'oracle complet, un second modèle, et la réponse parfaite en un seul appel.
- **La limite :** le contenu de E est construit à la main à partir de la vérité terrain. C'est la meilleure
  réponse concevable, pas la sortie d'un outil. (Deux appels autorisés ont été refusés au premier round,
  sans ce round, le résultat est le même, 0,43x.)

**La question reste entière : un tel outil est-il constructible ?** Pour réduire le payload à la réponse, il faut
trier les données utiles des superflues. Or ce tri dépend de la question de l'utilisateur, en langage
naturel : c'est un jugement sémantique, pas un fait structurel. Construire exactement E revient à résoudre
la tâche. Au sens strict, il n'est donc pas constructible. Mais on peut s'en approcher :

- **la cible n'est pas la réponse parfaite**, c'est un payload sous ~7k tokens avec un rappel complet. La
  carte de l'étape 2 pèse à elle seule près des deux tiers du payload de C. Un élagage purement structurel pourrait donc suffire, cela reste à prouver.
- **le tri peut être payé ailleurs que dans le contexte de l'agent** : par un petit modèle, dans un contexte
  séparé, une seule fois, au lieu d'être fait par l'agent principal, qui relit tout le payload à chaque tour...

Et même un tri parfait reste plafonné par le plancher de vérification.

### 8.2 La taille du plancher dépend-elle du modèle ?

Sur Sonnet 5, l'oracle a fait moins de vérifications après `DONE` (7,0 en moyenne contre 10,2, sur 3 rounds)
et a coûté à peu près autant que son contrôle, au lieu de 1,26x (§6.2). Si cela se confirme à 5 rounds, une
partie de la valeur mesurée d'un outil de récupération dépend de la quantité de vérification du modèle, pas
de l'outil. Il faudrait les bras A et C sur 5 rounds ou plus, sur les deux modèles, sur une même machine.

---

** Section générée par IA **

## Annexe A - Reproduction

```
bench/replay-ceiling/run-arms.sh <round-id>          # un round = trois bras, dans un ordre tiré au hasard
python3 bench/replay-ceiling/measure.py              # décomposition du coût, seuil de rentabilité, plancher de vérification
python3 bench/replay-ceiling/verify_independent.py   # une seconde implémentation, sans aucun code en commun
```

`verify_independent.py` recalcule chaque chiffre de cette étude à partir des transcripts bruts, sans importer
`measure.py`. Deux implémentations qui n'ont jamais partagé de code doivent tomber d'accord, sinon l'une des
deux est fausse. Elles sont d'accord sur chaque chiffre ; là où elles ne l'étaient pas au départ, et ce qui a
changé, est décrit dans [`STUDY_AUDIT.md`](STUDY_AUDIT.md). Les tableaux round par round sont affichés par
les deux scripts.

## Annexe B - Relecture externe

L'ajustement des refus (§1, §4.1) vient d'une relecture externe, qui a repéré que des tours refusés étaient
comptés comme du comportement de l'agent. La leçon dépasse ce cas : un audit de contamination vérifie que le
contrôle a tenu ; il ne vérifie pas si les coûts propres au dispositif sont mis sur le compte du bras testé.

---

## Déclaration d'usage de l'IA

Cette étude a été menée avec l'aide de Claude Code (Anthropic), sous ma direction. L'outil Seam, le dispositif
de benchmark, l'oracle de replay, les scripts d'analyse et le vérificateur indépendant ont été écrits par
l'agent à partir de mes instructions ; l'agent a aussi aidé à relire, corriger et traduire le texte.

Ce qui relève de l'auteur : la question de départ, née d'une observation faite en construisant Seam ; la
conception des expériences (l'oracle, les bras D et E, le second modèle) ; les décisions de méthode, comme
écarter un lot ou exiger une seconde implémentation ; et le texte, réécrit avec mes propres mots avant d'être
corrigé. J'assume l'entière responsabilité du contenu.

Deux limites en découlent, et je les signale. Le vérificateur indépendant ne partage aucun code avec le
dispositif, mais il a été écrit par le même type d'agent : il est indépendant par son code, pas par son
auteur, et peut partager les mêmes angles morts. Et l'agent étudié comme l'assistant viennent du même
fournisseur. Les mesures, elles, ne dépendent pas de l'assistant : elles viennent des comptes de tokens et
des coûts facturés que le fournisseur enregistre dans chaque transcript, et ces transcripts sont publiés.

---

## Références

- arXiv **2607.12161** - *Token Reduction Is Not Cost Reduction: An Empirical Study of End-to-End Efficiency
  in API-Based Coding Agents.* Le travail principal sur le mécanisme de coût de la section 4.
- arXiv **2606.14476** - Wang & Vemuri, *When the Tool Decides: LLM Agents Defer Blindly to Graph Neural
  Network Tools, and Stronger Backbones Defer More*, 12 juin 2026.
- arXiv **2605.29893** - *Redundant or Necessary? A Benchmark for Detecting Redundant Steps in Agent
  Trajectories.*
