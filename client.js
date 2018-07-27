const util = require('util')
const axios = require('axios')

console.log(process.argv);
const port = process.argv[2];

axios.post(`http://localhost:${port}/account`, {
    password: 'quang'
}).then(resp => {
    console.log(resp.data)
})
    .catch((err) => {
        if(err) 
            console.log(err)
    })