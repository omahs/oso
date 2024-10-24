from dotenv import load_dotenv
import os
import yaml
from yaml_formatter import dump


load_dotenv()
LOCAL_PATH = os.getenv("LOCAL_PATH_TO_OSSD")


def get_yaml_files(path):
    yaml_files = []
    for root, dirs, files in os.walk(path):
        for file in files:
            if file.endswith(".yaml"):
                yaml_files.append(os.path.join(root, file))
    return yaml_files


def get_yaml_data(yaml_files):
    yaml_data = []
    for file in yaml_files:
        with open(file, 'r') as stream:
            try:
                data = yaml.safe_load(stream)
                if data:
                    yaml_data.append(data)
            except yaml.YAMLError as exc:
                print(f"Error in {file}: {exc}")
    return yaml_data


def get_yaml_data_from_path():
    yaml_files = get_yaml_files(LOCAL_PATH)
    if not yaml_files:
        print("No YAML files found.")
        return []
        
    print(f"Found {len(yaml_files)} yaml files.")
    yaml_data = get_yaml_data(yaml_files)
    print(f"Ingested {len(yaml_data)} yaml records.")
    return yaml_data


def update_yaml_data(yaml_data):
    print(f"Exporting {len(yaml_data)} yaml records to {LOCAL_PATH}.")
    for data in yaml_data:
        if not data:
            continue
        slug = data['slug']
        path = os.path.join(LOCAL_PATH, slug[0], slug + ".yaml")        
        dump(data, path)


def main():
    # test the script
    yaml_data = get_yaml_data_from_path()
    update_yaml_data(yaml_data)


#main()