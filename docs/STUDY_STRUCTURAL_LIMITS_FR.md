# Ce que coûte un outil de navigation de code idéal : le plancher de vérification et la prime d'écriture

> Version française, rédigée par l'auteur avec ses propres mots puis corrigée. Elle sert de base à la
> traduction anglaise destinée à arXiv. La version de référence des chiffres reste
> [`STUDY_STRUCTURAL_LIMITS.md`](STUDY_STRUCTURAL_LIMITS.md), dont chaque figure est recalculée par
> `bench/replay-ceiling/verify_independent.py`. La section 6 reste à reprendre.

Une étude récente (arXiv 2607.12161) a montré qu'une réduction du nombre de tokens n'implique pas
forcément une réduction des coûts.

Ici, nous avons testé une approche différente, avec à l'appui un outil nommé « Seam », issu d'un projet
qui avait pour objectif d'optimiser les coûts et les performances d'un agent lors du traçage d'un « flow »
de code.

Une fois Seam fabriqué, je me suis rendu compte que, malgré un nombre d'appels d'outils divisé par 2,7 en
moyenne sur mon jeu de test Keycloak, et malgré moins de tokens consommés au total, la facture avait
augmenté de 18 % et le temps de 9 %, alors que je m'attendais à l'inverse. Une seule catégorie de tokens
avait augmenté : l'écriture dans le cache.

Ce résultat m'a amené à créer un « replay » représentant l'outil structurel déterministe parfait, sans
aucune latence, et à réaliser un benchmark basé dessus. L'outil de replay contient la réponse « parfaite »
typique sur un flow d'exécution, sans latence ni surcharge, et le bras correspondant l'obtient en cinq
appels d'outil successifs. Au sixième appel, l'oracle affiche « DONE » : la réponse est complète.

Encore plus étonnant : avec ce scénario d'outil parfait, l'agent obtient la réponse en peu d'appels, mais
une fois la réponse récupérée, il a tendance à la revérifier et à s'étendre, en continuant à consommer des
tokens.

En chiffres, sur 5 rounds appariés :

- l'outil parfait coûte **1,13x** le contrôle grep (1,26x en brut, appels refusés compris) ;
- la totalité du surcoût restant, **+13 %**, vient de l'écriture dans le cache ;
- après une réponse complète, l'agent fait encore **14,8 appels** (10,2 exécutés, 4,6 refusés), qui
  représentent **52 %** du coût du run ;
- lui donner en plus un moyen de recherche rend chaque vérification moins chère, mais ne change presque
  pas le nombre de vérifications ;
- ce plancher se retrouve sur un second modèle (Sonnet, 3 rounds), dans chaque round, mais plus petit.

---

## 1. Motivation

Seam trace un flow de code à travers un dépôt : quels fichiers y participent, où il traverse une frontière
de langage ou de service, où il se termine. L'hypothèse de départ était évidente : un outil qui répond en
moins d'étapes qu'un agent qui avance à coups de grep devrait coûter moins cher que cet agent.

`[kcC]` Six rounds appariés ont confirmé la première moitié et réfuté la seconde : **2,7x moins d'appels
d'outils, et une facture 18 % plus élevée.** Chaque catégorie de tokens que l'outil devait faire baisser a
baissé — tokens de sortie −19 %, lectures du cache −19 %, temps d'API −19 % — et la facture a monté quand
même, parce que la seule catégorie qui a augmenté est **l'écriture dans le cache** (x1,79). Le temps total
a augmenté de 9 %.

**Moins d'appels, moins de tokens, plus d'argent.** C'est l'observation que cette étude cherche à
expliquer.

**Périmètre, annoncé avant les chiffres : une tâche, un dépôt, cinq rounds appariés.** Le dépôt est
Keycloak — un monolithe, un serveur Java avec un client d'administration en TypeScript — et la tâche est un
seul traçage qui traverse les deux langages. Chaque chiffre ci-dessous est une moyenne sur ces 5 rounds,
sauf ceux marqués `[kcC]`, qui viennent de la mesure antérieure à six rounds sur le même dépôt.

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

« À égalité » signifie à moins de 1 % du contrôle. Aucun round n'est moins cher que grep.

La qualité des réponses est comparable entre les bras. Elle est rapportée en §7 comme une tendance (n=5,
intervalles qui se recouvrent), et rien dans l'argument ne repose dessus.

**Le chiffre qui résume la section 4.** Sans les appels refusés, l'arm idéal lit au total **983k tokens de
contexte, contre 980k pour grep**. Mais il avait la réponse complète à **346k**, soit environ un tiers de ce
que lit grep : c'est la vérification qui le ramène au niveau de grep (§4.1, §5).

**L'ajustement des refus, en un paragraphe.** Les bras SEAM et REPLAY n'ont pas accès à la recherche de
contenu, donc certains de leurs tours sont des refus. Un refus coûte quand même un tour (le prompt est
renvoyé), mais c'est le dispositif qui l'impose, pas l'agent qui le choisit. La ligne ajustée retire donc
une relecture du prompt par refus. Ce n'est pas un détail comptable : sans cet ajustement, l'arm idéal lit
27 % de contexte de plus que grep, et on ne pourrait plus dire que la prime d'écriture est la totalité du
surcoût (§4.2). Les deux lignes répondent à deux questions : la ligne brute compare un outil qui
**remplace** grep, la ligne ajustée un outil utilisé **à côté de** grep (§6.2.4).

---

## 2. Travaux associés

**Le mécanisme de coût est déjà établi.** L'étude *Token Reduction Is Not Cost Reduction* (arXiv 2607.12161)
mesure 2 908 runs Claude Code facturés, sur 103 tâches, 7 dépôts et 3 modèles. Elle traite un sujet
corollaire, sans couvrir celui-ci. Elle montre en particulier :

- qu'une réduction de tokens au niveau d'un composant ne prédit pas le coût de bout en bout (corrélation de
  Pearson au niveau de la tâche **r = 0,154**) ;
- que la facture est **dominée par le cache** : écriture 44,3 % + lecture 35,4 % ≈ 80 % du total ;
- un modèle formel du coût marginal d'un token injecté au tour *t*, avec les multiplicateurs d'écriture et de
  lecture et le nombre de relectures futures — c'est-à-dire l'argument d'amortissement, déjà formalisé ;
- que sa compression la plus agressive a réduit les tokens de sortie d'outil de **38,4 %** et augmenté le
  coût facturé de **6,8 %**.

Dans cette étude, je me concentre sur trois points qu'elle laisse ouverts :

1. **L'intervention opposée.** Elle compresse : elle retire de la sortie d'outil pour économiser des tokens.
   Ici on injecte : un payload plus large en contrepartie de beaucoup moins d'appels. La direction est
   opposée et la conclusion reste la même : les coûts augmentent. C'est donc une corroboration indépendante,
   pas une réplication.
2. **L'isolation de la vérification.** Avec une compression, l'agent peut légitimement relire ce qui a été
   coupé : relecture et manque d'information sont confondus. Ici rien n'est retiré et rien n'est faux : la
   réponse est complète. Toute vérification après `DONE` ne s'explique donc par aucun manque d'information.
3. **Le coût d'un outil parfait.** Aucun travail de ce domaine ne mesure ce que coûterait un outil optimal,
   qui ne pourrait jamais exister en pratique, mais qui représente la meilleure version possible de tout outil
   de ce type : le replay.

**Travaux voisins.** *Redundant or Necessary?* (arXiv 2605.29893) construit un benchmark pour **détecter** les
étapes redondantes d'un agent ; il les classe sans les chiffrer, et n'a pas d'arm oracle.

*When the Tool Decides: LLM Agents Defer Blindly to Graph Neural Network Tools* (arXiv 2606.14476) semble
dire l'inverse de la section 5 : ses agents recopient la réponse de leur outil, un réseau de neurones sur
graphe (un modèle qui prédit l'étiquette d'un nœud à partir de ses voisins), avec un accord de 0,976 à
0,992. **Lu en entier, il ne la contredit pas.** Son agent ne peut pas vérifier : l'outil lui donne
directement l'étiquette qu'il doit rendre, et il n'a rien d'extérieur pour la contrôler. Le nôtre a le dépôt
ouvert à côté de lui et peut vérifier chaque affirmation de l'oracle. Les deux résultats sont les deux
moitiés d'une même règle, qui borne celui de la section 5 : **un agent recopie quand il ne peut pas
vérifier, et vérifie quand il le peut.** Cet article mesure aussi autre chose que nous (ce que l'agent fait
de la réponse, pas combien d'appels il choisit de faire), et son effet extrême est en partie propre au
modèle Qwen, d'après ses propres auteurs.

---

## 3. Méthode

### 3.1 Les bras et les contrôles

Une tâche, un commit du dépôt, trois bras exécutés à la suite dans une même invocation. Le modèle est fixé
(`claude-opus-5[1m]`) ; le CLI facture aussi un petit modèle auxiliaire dans chaque run, environ 0,5 % du
coût, inclus dans tous les totaux. **L'ordre des bras est tiré au hasard à chaque round.** La contamination
entre bras est vérifiée dans les transcripts, pas supposée à partir des options : **les cinq rounds sont
propres**.

- **A — GREP** : ripgrep et lecture de fichiers. Le contrôle.
- **B — SEAM** : le vrai CLI avec son vrai `SKILL.md`. Le produit tel qu'il est livré.
- **C — REPLAY** : l'oracle idéalisé (§3.2).

La **seule** capacité qui diffère est la recherche de contenu : tous les bras ont les mêmes commandes de
lecture et de listing, et l'outil `Read` ; seul A a `rg`, `grep`, `Grep` et `Glob`.

### 3.2 L'instrument : l'oracle de replay est une borne supérieure, pas une approximation

`call-flow --step N` sert cinq fichiers enregistrés, dans un ordre imposé, puis affiche `DONE`. Chaque étape
est **la sortie exacte qu'un vrai run de Seam a produite** sur cette question et ce commit. L'oracle supprime
toutes les façons dont un outil de récupération peut perdre :

| supprimé | arm C (REPLAY) | arm B (SEAM) |
|---|---|---|
| latence du moteur | ~1 ms (un `cat`) — indiscernable du contrôle | **+20,6 s** hors API par run |
| mauvais chemins, mauvais point de départ | aucun : ordre fixé à l'avance | l'agent choisit |
| coût de la documentation | ~300 octets | 42 Ko, présents à chaque tour |
| rappel | 100 % de la vérité terrain par construction | mesuré |

Le *choix* des étapes est idéalisé ; leur *contenu* ne l'est pas. Aucune ligne n'a été écrite pour le
benchmark : les cinq sorties enregistrées ont été choisies parce qu'ensemble elles couvrent les 12 entrées
de la vérité terrain (`bench/replay-ceiling/truth.txt`).

**Ce qu'est le payload.** Le payload, c'est le texte que l'outil injecte dans le contexte de l'agent. Ici,
les cinq étapes livrent **43 Ko de texte, environ 13k tokens** :

1. **la table des routes** (1,9 Ko) : 147 routes trouvées, dont une seule résolue des deux côtés, celle que
   la tâche demande ;
2. **la carte pour l'agent** (27 Ko, l'essentiel du payload) : la région du code à lire au lieu d'enchaîner
   des grep, avec les lignes de code source ;
3. **le couplage entre les deux langages** de la ressource Java (4,7 Ko), indexé par route plutôt que par
   symbole ;
4. et 5. **huit symboles nommés**, chacun résolu en un fichier et une ligne (5,7 Ko + 4,4 Ko).

Un détail explique la taille du payload : `getRealm` a 207 définitions dans le dépôt, et l'outil en renvoie
25 en laissant l'agent choisir. **Un outil structurel est gros en partie parce qu'il refuse de trancher à la
place de l'agent** : il est honnête sur ce qu'il ne peut pas réduire, et cette honnêteté coûte des octets.

**Pourquoi c'est le bon instrument.** Tant qu'on compare des outils imparfaits, un résultat décevant peut
toujours s'expliquer par un outil « pas encore assez bon », et cette hypothèse ne peut jamais être réfutée,
puisqu'il y a toujours une amélioration possible. L'oracle donne la réponse complète, sans délai ni erreur :
aucun outil de ce type ne peut faire mieux sur cette tâche. **Donc si l'oracle ne bat pas grep, aucune
version de l'outil ne le battra.** La question n'est plus « le moteur est-il assez bon ? », mais porte sur
toute la catégorie d'outils.

**Ce que la borne couvre, et ce qu'elle ne couvre pas.** Elle ne vaut que pour les outils qui répondent en
**injectant du texte dans le contexte de l'agent**. Elle ne dit rien d'un outil qui changerait ce que
l'agent fait d'une réponse : un outil qui l'empêcherait de revérifier, ou qui garderait son payload d'une
conversation à l'autre au lieu de le réécrire à chaque fois.

**Coût pour le reproduire sur n'importe quel outil :** figer les sorties de l'outil sur une tâche, les
servir avec `cat`, écrire un manuel de 300 octets.

Le temps hors API (temps total moins temps d'API) n'est qu'une approximation grossière du temps du moteur :
il est même légèrement négatif pour le contrôle. Les +20,6 s de Seam sont assez grands pour être lus ; celui
de l'oracle est donné comme indiscernable du contrôle plutôt que comme un chiffre.

### 3.3 Modèle de coût

Quatre catégories de tokens facturés, ajustées sur l'entrée `modelUsage` du modèle de l'agent dans chaque
run enregistré :

```
entrée          5,00 $ /Mtok
lecture cache   0,50 $ /Mtok    payée À CHAQUE tour, sur tout le prompt
écriture cache 10,00 $ /Mtok    payée UNE FOIS par octet, au tour où il entre dans le contexte
                                (TTL 1 h ; TTL 5 min = 6,25 $)
sortie         25,00 $ /Mtok
```

L'ajustement est exact (résidu inférieur à 0,000001 $), donc chaque décomposition est de l'arithmétique sur
les prix facturés, pas une estimation.

---

## 4. Le mécanisme de coût

Cette section reprend un mécanisme déjà établi par 2607.12161 ; ce n'est pas un résultat de cette étude.
Elle l'énonce du côté de l'injection, là où la littérature l'énonce du côté de la compression.

Le surcoût d'un outil de récupération de code vient de la façon dont le cache est écrit et lu. À chaque
tour, toute la conversation est renvoyée au modèle : le prompt initial, les payloads des outils et toutes
les réponses précédentes. Elle grossit donc à chaque tour. Un payload agit alors de deux façons :

1. **il alourdit chaque tour suivant**, puisqu'il est relu à chaque tour (§4.1) ;
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
contexte total de l'arm finit sous celui du contrôle :

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

Concrètement, l'arm idéal avait la réponse complète à **346k**, environ un tiers de ce que lit grep. Côté
lecture, il gagne donc largement ; ce qui le ramène sur la ligne de grep, ce sont les **637k** que l'agent
passe ensuite à vérifier une réponse déjà complète. Seam, lui, perd l'échange dans les deux cas (1,18).

![Contexte total par run, appels refusés séparés](figures/02-area-not-endpoint.svg)

***Figure 2.** Chaque barre est le contexte total d'un arm (tours × contexte par tour), sur une même
échelle. L'extrémité hachurée correspond aux appels refusés, seule partie que l'ajustement retire. La ligne
verticale marque le contrôle. La barre de l'arm idéal est coupée là où sa réponse est devenue complète
(`DONE`, au 6e appel dans chaque round) : 346k pour y arriver, puis 637k de vérification. Seul cet arm peut
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
écart de coût ajusté de l'arm C par rapport à GREP :
    écriture cache   +0,1321 $      <- la totalité
    lecture cache    −0,0051 $      <- indiscernable de zéro
    sortie           +0,0047 $
    TOTAL            +0,1317 $      = +13 %
```

![Où va l'argent de l'outil idéal](figures/05-where-the-money-goes.svg)

***Figure 5.** Avec une lecture neutre sur un outil optimal par construction, la prime d'écriture n'est pas
un contributeur parmi d'autres : c'est tout le surcoût restant.*

L'essentiel de ce surcoût est donc la mise en place, qui est une écriture dans le cache. Ce coût est
payé une fois par octet, au tour où l'octet entre dans le contexte, ce qui implique une notion
d'amortissement au fil des appels : plus il reste d'appels après lui, plus le coût de mise en place s'étale
sur l'ensemble de ces appels. Un octet écrit une fois puis lu *T* fois coûte `(10 + 0,5T)/T` dollars par
million de tokens et par tour d'utilisation :

| tours après le payload | 20 | 10 | 4 | 2 | 1 |
|---|---|---|---|---|---|
| prix effectif ($/Mtok-tour) | 1,00 $ | 1,50 $ | 3,00 $ | 5,50 $ | 10,50 $ |

L'écriture se fait au fil des tours, pas d'un bloc : chaque tour écrit ce qui est nouveau depuis le
précédent. Le prompt au tour 1 (14,1k, à peu près identique dans tous les bras), puis chaque résultat
d'outil au tour qui suit son retour. Les cinq étapes de l'oracle arrivent aux tours 2 à 6, et l'une domine :
l'étape 2, la carte de 11,7k, écrite au tour 3. Les résultats de grep sont écrits de la même façon, par
morceaux d'environ 1k à 3k répartis sur tout le run.

Le problème : un outil de récupération suffisamment optimisé a justement pour objectif de diminuer les tours,
ce qui raccourcit la période sur laquelle sa propre écriture s'amortit. En admettant qu'on atteigne un seul
appel, chaque octet du payload coûtera environ 20x le prix d'une lecture, là où grep a le profil inverse :
ses octets arrivent tard, sont relus peu de fois, mais au prix normal.

![L'inversion de l'amortissement](figures/03-amortisation-inversion.svg)

***Figure 3.** Un octet écrit une fois et lu T fois coûte (10 + 0,5T)/T par Mtok-tour. Réduire les tours fait
glisser l'outil vers la gauche de la courbe, vers la prime complète de 20x sur ses propres octets.*

**Ce qui s'est passé quand les tours ont vraiment baissé.** `[kcC]` Dans la mesure antérieure à six rounds
(§1), Seam a divisé les tours par 2,6 (de 24,7 à 9,7). Pour cela, il a ajouté 24,1k tokens d'écriture et
économisé 136,8k tokens de lecture : un rapport de **0,176, soit 3,5x au-dessus du seuil**. Pour être
rentable, son payload aurait dû tenir en 6 838 tokens (la carte seule en fait environ 7k), ou il aurait
fallu répondre en **3,9 tours, moins que ses 8,7 appels d'outils**.

**Note d'honnêteté.** Ce calcul ne rend pas impossible un vrai outil à un seul appel. Avec un payload
hypothétique de 36k tokens et un seul tour, l'écriture coûte 0,36 $, contre environ 0,49 $ de lecture
accumulée pour grep : il gagnerait. La section 5 explique pourquoi ce régime n'est jamais atteint.

### 4.3 Le thinking double, et ne pèse presque pas sur la facture

Mesuré avec le compte du fournisseur, le contrôle « pense » **1 108** tokens par run, Seam **2 177**
(**1,97x**) et l'arm idéal **2 145** (**1,94x**). Le thinking double en comparaison avec grep, mais ce n'est
pas la cause du surcoût, pour deux raisons.

Premièrement, le thinking est compté comme de la sortie, et la sortie est une petite partie de la facture :
environ 6,5k tokens par run, contre environ 1M de tokens de contexte. Dans l'arm idéal, la sortie représente
13 % du coût.

Deuxièmement, le surplus de thinking est presque entièrement compensé. Les bras qui pensent plus écrivent
moins de texte et d'appels, parce qu'ils font moins d'appels : l'arm idéal pense environ 1 040 tokens de plus
que le contrôle, mais écrit environ 850 tokens de moins. Sa sortie totale n'augmente que d'environ 190
tokens, soit les +0,0047 $ de §4.2, moins de 4 % de son surcoût ajusté. Compter le thinking seul le
surestimerait d'environ cinq fois.

Où ce thinking a lieu est un résultat de la section 5 : 99 % se trouve après `DONE`.

---

## 5. Résultat : le plancher de vérification

En résumé : le plancher de vérification, ce sont des tours entièrement consacrés à vérifier la réponse, et
non à la construire. C'est un plancher parce qu'améliorer la réponse de l'outil ne le fait pas baisser :
même avec une réponse parfaite et complète, l'agent vérifie. C'est aussi pour cela qu'il reste invisible
dans toute expérience qui compare deux outils imparfaits.

![Le plancher de vérification](figures/04-verification-floor.svg)

***Figure 4.** L'arm idéal, seul : les autres bras n'ont pas de marqueur de fin, donc la quantité n'est pas
mesurable pour eux. Six appels mènent à une réponse prouvée complète ; 14,8 suivent, et les 23 refus des cinq
rounds tombent tous dans cette seconde partie.*

| REPLAY (idéal), par run | appels d'outils | dont exécutés | dont refusés | part du coût du run |
|---|---|---|---|---|
| avant `DONE` : obtenir la réponse | 6,0 | 6,0 | 0,0 | 48 % |
| **après `DONE` : la vérifier** | **14,8** | **10,2** | **4,6** | **52 %** |

Sur l'arm idéal, `DONE` est atteint au bout de 6 appels. Les 20,8 appels du run (en moyenne sur 5 rounds)
se répartissent donc en 6 appels pour obtenir la réponse et 14,8 appels de vérification, dont 4,6 sont des
appels refusés. L'agent termine en 21,8 tours contre 23,4 pour grep : 7 % de moins, avec un outil qui lui
avait déjà donné toute la réponse. Les autres bras n'ont pas de tel marqueur par construction : ni grep ni
Seam ne savent, et nous non plus, à quel moment ils ont toute la réponse. Ils ne peuvent donc pas être
inclus dans cette comparaison.

Si on reprend la figure 2, on note que 346k de contexte sont nécessaires pour atteindre la réponse, et 637k
sont consacrés à la vérification (plus 263k d'appels refusés). La vérification seule lit 65 % de ce que grep
lit pour toute la tâche. **99 % du thinking** de l'arm idéal se trouve dans cette phase : 19 tokens par run
pendant les six appels qui apportent la réponse, 2 126 pendant la vérification. Le modèle ne réfléchit
presque pas pendant que la réponse arrive ; il réfléchit pendant qu'il vérifie une réponse déjà complète.

Les 14,8 appels représentent 71 % des appels de l'arm, mais seulement 52 % de son coût. C'est le mécanisme
de §4.2 à l'intérieur d'un seul run : les sept premiers appels portent 67 % de l'écriture dans le cache,
parce que le payload y arrive, et la longue suite après `DONE` relit à un vingtième de ce prix.

De plus, **les 23 refus des cinq rounds tombent tous après `DONE`**, aucun avant. Ce sont tous des tentatives
de recherche (`grep`, `rg`) : la lecture de fichiers n'a jamais été interdite, et c'est d'ailleurs comme ça
que l'arm idéal vérifie. L'agent suit l'oracle jusqu'au bout sans jamais tenter de le contourner, et ne
cherche des outils dont on lui a dit qu'il ne les avait pas qu'une fois la réponse en main. Un agent qui,
avec une réponse prouvée complète, tente encore près de cinq fois par run un outil de recherche qu'il n'a pas
montre la force de ce besoin de vérifier mieux que le simple nombre d'appels. Sans les refus, le plancher
reste de 10,2 appels exécutés.

**Le plancher a une limite :** un agent qui reçoit une réponse d'outil qu'il ne peut pas vérifier la recopie
au lieu de la vérifier (§2). Ici, le dépôt est ouvert à côté de l'agent, donc chaque affirmation de l'oracle
peut être vérifiée.

**Ce n'est pas de la méfiance envers l'outil.** Il n'y a plus rien dont se méfier : la réponse est complète,
correcte, et produite par l'outil lui-même.

### 5.1 L'outil est à son meilleur, et la vérification reste

L'affirmation de cette section : **la vérification après la réponse vient du comportement du modèle, pas
d'une faiblesse de l'outil.** L'arm idéal la teste en mettant à leur meilleur, toutes en même temps, les
variables de l'outil qui gouvernent l'*obtention* de la réponse :

| variable de l'outil | état dans l'arm idéal | a-t-elle supprimé la vérification après `DONE` ? |
|---|---|---|
| latence | nulle : l'oracle est un `cat` ; le moteur de Seam ajoute 20,6 s hors API par run (§3.2) | non |
| complétude | totale : les cinq étapes couvrent les 12 entrées de la vérité terrain | non |
| documentation | minimale : un manuel de 300 octets contre 42 Ko pour Seam | non |
| un moyen de vérifier | **absent** : plus rien à demander à l'oracle après `DONE`, et la recherche est refusée | mesuré en §5.2 |

Avec tout cela, l'arm idéal coûte encore **1,13x le contrôle** (ajusté ; 1,26x brut) et fait **10,2 appels
exécutés après que la réponse est complète**. La seule variable qu'il laisse à son pire est la dernière :
une fois `DONE` affiché, chaque vérification doit passer par la lecture de fichiers entiers. La section 5.2
donne la recherche à l'agent et mesure la différence.

### 5.2 L'agent vérifie-t-il autant parce qu'il n'a pas de bon moyen de vérifier ? — l'arm D

**L'arm D est l'arm idéal plus la recherche ordinaire** : même oracle, même manuel, plus le `grep`/`rg` du
contrôle. Si la vérification après `DONE` n'était que le prix de l'absence de recherche, l'arm D vérifierait
beaucoup moins. Les bras A, C et D ont tourné ensemble, cinq rounds appariés dans un ordre tiré au hasard, sur
une même machine (`bench/replay-ceiling/results-oracle-grep/`).

| par run, après `DONE` | REPLAY (sans recherche) | REPLAY + grep (arm D) |
|---|---|---|
| tentatives de recherche refusées | 7,8 | 0 |
| recherches exécutées | 0 | 6,2 |
| lectures de fichiers exécutées | 17,0 | 9,6 |
| autres (`ls`, `find`) | 1,4 | 0 |
| **vérifications réellement exécutées** | **18,4** | **15,8** |

Une commande qui lit et cherche à la fois (`sed … && grep …`) compte comme une recherche, puisqu'elle en
exécute une.

| par run, sur tout le run — cette machine | GREP | REPLAY | REPLAY + grep |
|---|---|---|---|
| appels d'outils | 35,2 | 32,2 | 21,8 |
| coût facturé vs GREP | 1,00 | 1,23 brut · 1,06 ajusté | **0,91** |

Trois résultats :

1. **La recherche change la façon dont l'agent vérifie, pas la quantité.** Le nombre d'appels de l'arm D
   après `DONE` baisse de 10,4, mais 7,8 d'entre eux sont les tentatives refusées, qui cessent simplement
   dès que la recherche est permise. Les vérifications réellement exécutées passent de 18,4 à 15,8 : moins
   dans 4 rounds sur 5, plus dans 1, ce qui n'est pas significatif à n=5 (t apparié = 1,86, 4 degrés de
   liberté). Ce qui change, c'est leur nature : environ la moitié des lectures de fichiers entiers deviennent
   des recherches ciblées.
2. **Le plancher résiste au moyen de vérifier.** Avec la recherche disponible et aucun refus, l'arm D fait
   encore **15,8 appels après une réponse prouvée complète**, soit 72 % de tous ses appels. Il a suivi
   l'oracle jusqu'à `DONE` dans chaque round, sans rien chercher avant.
3. **En coût, l'outil idéal utilisé à côté de grep est au niveau de grep seul.** L'arm D coûte **0,91x** le
   contrôle, ce qui n'est pas distinguable de 1,0 à n=5 (écart-type 0,28 ; au-dessus de 1,0 dans 1 round, à
   égalité dans 1, en dessous dans 3). Ses vérifications coûtent moins cher, très probablement parce qu'une
   recherche renvoie moins de texte qu'un fichier entier : l'arm D est moins cher que l'arm idéal sans
   recherche dans les 5 rounds en brut, et dans 4 sur 5 en ajusté. L'arm idéal sans recherche perd toujours
   (1,06x ajusté, 1,23x brut), dans le même sens que les rounds publiés. La conclusion dépend donc de l'usage
   que distingue §6.2.4 : utilisé **à la place** de grep, l'outil idéal perd ; utilisé **à côté** de grep, il
   fait jeu égal. Il ne gagne jamais nettement.

**Comparer ces tableaux entre eux, jamais avec celui de §1.** Sur cette machine, chaque arm fait environ 1,55x
le nombre d'appels publié (GREP 35,2 contre 22,4), et la vérification après `DONE` de l'arm idéal est 1,77x
plus longue (26,2 contre 14,8). Le CLI a 43 versions de plus et Keycloak six jours de plus. L'*existence* du
plancher se reproduit — il est même plus grand ici — mais sa *taille* dépend de la machine, et seules les
comparaisons à l'intérieur de ce lot sont appariées. Un premier lot a été écarté parce que le dispositif ne
pouvait pas atteindre le dépôt depuis le shell (`results-oracle-grep/discarded-outside-workdir/WHY.md`).

---

## 6. Menaces à la validité

*À reprendre. Voir la section 6 de la version anglaise.*

---

## Références

- arXiv **2607.12161** — *Token Reduction Is Not Cost Reduction.* Le travail principal sur le mécanisme de
  coût de la section 4.
- arXiv **2606.14476** — *When the Tool Decides: LLM Agents Defer Blindly to Graph Neural Network Tools.*
- arXiv **2605.29893** — *Redundant or Necessary?*
