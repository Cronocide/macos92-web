#!/usr/bin/env groovy

pipeline {
	agent {
		label 'nomad'
	}
	parameters {
		string(name: 'GIT_REPO_NAME', defaultValue: 'git.cronocide.net', description: 'The hostname of the git repository.')
		string(name: 'USERN', defaultValue: 'cronocide', description: 'The username of the user in the git repository.')
		booleanParam(name: 'PREPARE', defaultValue: true, description: 'Do preparations on this project.')
		booleanParam(name: 'INSPECT', defaultValue: false, description: 'Do inspections on this project.')
		booleanParam(name: 'BUILD', defaultValue: true, description: 'Do builds on this project.')
		booleanParam(name: 'TEST', defaultValue: true, description: 'Do tests on this project.')
		booleanParam(name: 'PUBLISH', defaultValue: true, description: 'Publish this project.')
		booleanParam(name: 'DEPLOY', defaultValue: false, description: 'Deploy this project.')
	}
	environment {
		WORKSPACE_PATH = "/opt/nomad/alloc/${NOMAD_ALLOC_ID}/${NOMAD_TASK_NAME}${WORKSPACE}"
		DESCRIPTION = "Qemu PPC (Screamer audio) binary with noVNC web interface."
	}
	triggers { cron('H 3 * * 1') }
	stages {
		stage('Prepare') {
			when { expression { params.PREPARE } }
			steps {
				withEnv(['ACTION=cicd_prepare']) {
					sh ( script: './build.sh')
				}
			}
		}
		stage('Inspect') {
			when { expression { params.INSPECT } }
			steps {
				withEnv(['ACTION=cicd_inspect']) {
					sh ( script: './build.sh')
				}
			}
		}
		stage('Build') {
			when { expression { params.BUILD } }
			steps {
				withEnv(['ACTION=cicd_build']) {
					sh ( script: './build.sh')
				}
			}
		}
		stage('Test') {
			when { expression { params.TEST } }
			steps {
				withEnv(['ACTION=cicd_test']) {
					sh ( script: './build.sh')
				}
			}
		}
		stage('Publish') {
			when { expression { params.PUBLISH } }
			steps {
				withEnv(['ACTION=cicd_publish']) {
					sh ( script: './build.sh')
				}
			}
		}
		stage('Deploy') {
			when { expression { params.DEPLOY } }
			steps {
				withEnv(['ACTION=cicd_deploy']) {
					sh ( script: './build.sh')
				}
			}
		}
	}
	post {
		success {
				echo 'Pipeline succeeded.'
		}
		failure {
				echo 'Pipeline failed.'
		}
	}
}
