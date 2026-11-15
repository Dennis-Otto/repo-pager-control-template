# The command line of Mermaid with its Chromium, with which scripts/diagrams.sh draws the
# diagrams, pinned by its tag and its digest. Nothing builds this file: the script takes
# the image of its FROM, which Dependabot keeps current with a pull request.
FROM minlag/mermaid-cli:12.0.1@sha256:18938e53497376d524e04b1fc0bf7b6d61a491ce9ff7032bb2855d57155acb10
