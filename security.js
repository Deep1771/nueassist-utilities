function checkPermission(permTree,{appName,moduleName,groupName,access}){
    try{
        return permTree.apps
                    .find(app => app.name === appName)
                    .modules.find(module => module.name === moduleName)
                    .entities.find(entity => entity.name === groupName).access[access]
    }catch(e){
        return false
    }
}


module.exports = {
    checkPermission
}
