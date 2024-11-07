
cd $(dirname $0)
eslint -c ../.eslintrc.yml --ext .js,.mjs --fix .
