# zizmor, which the workflow Tests runs on the workflows for the ways a workflow gets
# attacked, pinned by its tag and its digest. Nothing builds this file: the workflow
# takes the image of its FROM, which Dependabot keeps current with a pull request.
FROM ghcr.io/zizmorcore/zizmor:1.32.0@sha256:3014cc8f68f663935f69b3c3e0e41f5ce102b268d97db13db0f62208747f860d
