# zizmor, which the workflow Tests runs on the workflows for the ways a workflow gets
# attacked, pinned by its tag and its digest. Nothing builds this file: the workflow
# takes the image of its FROM, which Dependabot keeps current with a pull request.
FROM ghcr.io/zizmorcore/zizmor:1.31.1@sha256:42d409dbb851d4c5d35a058cf042b828bea1e3f2884378c526eb0974780e18d9
