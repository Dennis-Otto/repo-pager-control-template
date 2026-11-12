# actionlint, which the workflow Tests runs on the workflows, pinned by its tag and its
# digest. Nothing builds this file: the workflow takes the image of its FROM, which
# Dependabot keeps current with a pull request.
FROM rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667
