EMTAC WORKFLOW – GitHub Releases OTA setup (Windows)

Configured publish target:
  owner: EMTACDTF
  repo:  EMTAC-Workflow

1) Push to GitHub (first time)
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/EMTACDTF/EMTAC-Workflow.git
   git push -u origin main

2) Create a release (build + publish automatically)
   - Bump version in package.json (e.g. 1.0.1)
   - Commit and push
   - Tag the version and push the tag:

     git add package.json
     git commit -m "Release v1.0.1"
     git push
     git tag v1.0.1
     git push origin v1.0.1
