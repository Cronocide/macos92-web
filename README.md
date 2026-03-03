# cicd-template

Template repository for Docker image creation and deployment.
[![Build Status](https://jenkins.cronocide.net/buildStatus/icon?job=git.cronocide.net%2Fcicd-template%2Fmaster&subject=Jenkins%20Build)](https://jenkins.cronocide.net/job/git.cronocide.net/job/cicd-template/job/master/)

# Deployment Checklist

* Add Jenkins user to project as a Developer in Git
* Write the description in the Jenkinsfile env variable
* Add a private Github push mirror
* Add `?job=` to the webhook for Jenkins
* Update the Jenkins build badge URL
* Rename the project in the README
* Delete this checklist from the README
