# Conversation des sous-agents Bridget

Le journal Bridget est adapté en données de conversation T3. Il passe par le même
`ThreadTimeline`, le même `MessagesTimeline` et les mêmes composants de messages,
de code et d’outils que les autres fils. Aucun second moteur de présentation
n’est maintenu. La page conserve ses contrôles Bridget et sa barre de lecture seule.

## Présentation et données

- Bulles, Markdown, coloration, cadres de code, copie et retour à la ligne :
  composants existants de T3 et préférences communes.
- Durée et repli des tours : composants existants ; début et fin doivent être
  observés, sans lacune ni conflit. Une durée absente reste inconnue.
- Commandes et outils : modèles natifs. Une invocation sans résultat reste neutre.
  La sortie partielle est identifiée comme extrait conservé.
- Erreurs terminales : carte d’erreur native, sans transformer un texte partiel
  en résultat favorable. Les événements non interprétés restent dans les détails bruts.
- Le résultat chargé explicitement est rendu par la même conversation.
- Les actions de modification, de réponse et d’exécution ne sont pas ajoutées.
  Les chemins distants ne deviennent pas des chemins locaux utilisables.
- Aucun journal importé n’est écrit dans les données T3. Les identifiants de rendu
  ne sont pas employés comme identifiants de commandes métier.

## Titres

La fonction existante `subagentThreadTitle` est partagée entre le fournisseur,
la projection native Bridget et les listes de sous-agents. Le titre affiché est
limité à 72 caractères, espaces normalisés, avec coupure à un mot si possible et
sans couper une paire Unicode. Les titres historiques passent aussi par ce formatage.
Le titre source et le prompt restent complets. Le repli sans titre utilise
l’ordinal de l’enfant dans le snapshot, au lieu de la constante 1.

## Vérifications du 8 novembre 2026

- `check:changed f78f502006` : 18 fichiers de tests, **504 tests verts** ;
  compilateur React ciblé : 6 contrôles verts.
- Lint, deux contrôles Knip, génération GraphQL et dépendances inutilisées : verts.
- TypeScript web et serveur : les deux commandes ciblées réussissent.
- Le contrôle TypeScript étendu termine en échec : le paquet Cursor sort avec le
  code 2 alors que sa sortie après correction du fixture ne contient que des
  avertissements/suggestions. Ce contrôle n’est pas déclaré vert.
  Le premier passage concurrent comportait aussi des sorties 137 ; le passage
  séquentiel conserve le défaut Cursor. Aucun diagnostic n’a été désactivé.
- Le dernier défaut de formatage concernait le nouveau test de titre ; il est
  corrigé et le contrôle de ce fichier est vert.
- La base non modifiée reproduisait les anciens échecs de fixture Cursor,
  de reprise Lineage et de budget MCP. Le fixture Cursor périmé est aligné,
  les commandes natives sans changement suivent le parcours idempotent existant,
  et le budget mesuré passe de 47809 à 48131 octets sans modifier le prompt.

La revue indépendante du raccord natif a relevé l’ordinal constant : corrigé,
avec test du vrai parcours de synchronisation. Son second point est écarté par
le contrat : seuls les événements `update` deviennent des activités ; un événement
`error` garde donc son chemin d’erreur. Le test d’erreur terminale le vérifie.
Cette revue est statique, pas une exécution indépendante des tests.

## Preuves et activation

[Diaporama](../../preuves-corrections/2026-11-08-bridget-conversation/preuves.html) :
vrai composant T3 en navigateur isolé, données de démonstration, quatre clics réels
enregistrés, cinq captures. Premier repère, navigation et dernière étape vérifiés.
Ce circuit ne prétend pas vérifier une session métier dans l’application installée.

Le paquet local est préparé séparément. L’application installée et sa base active
ne sont pas modifiées. La fermeture de T3 exige l’assentiment explicite de François.
La vérification d’un sous-agent dans l’application reste à faire après activation.
